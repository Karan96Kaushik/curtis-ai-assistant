const registry = require('../core/moduleRegistry');
const engine = require('../workflows/wfRelease/engine');
const { envelopeFromRaw } = require('../util/taskResult');
const { stageOrExecute } = require('../util/mutatingGate');
const { formatExportSummary } = require('../workflows/wfRelease/export');

const WF_ID_RE = /\b(wf-[a-z0-9]+-[a-z0-9]+)\b/i;

function extractWorkflowId(text) {
  const m = String(text || '').match(WF_ID_RE);
  return m ? m[1] : null;
}

function looksLikeReleaseStart(text) {
  const t = String(text || '');
  return (
    /\b(wf\s+)?release\b/i.test(t) ||
    /\bprepare\s+release\b/i.test(t) ||
    /\bhotfix\b/i.test(t) ||
    /\brelease\s+(pr|pull|for|from)\b/i.test(t) ||
    /\bdraft\b.{0,40}\brelease\b|\brelease\b.{0,40}\bdraft\b/i.test(t)
  );
}

function looksLikeDraftRequest(text) {
  const t = String(text || '');
  return (
    /\bdraft\b.{0,40}\brelease\b|\brelease\b.{0,40}\bdraft\b/i.test(t) ||
    /\b(prepare|create|make|share|show)\s+(a\s+)?(full\s+)?draft\b/i.test(t) ||
    /\bdraft\s+(the\s+)?(release|plan)\b/i.test(t)
  );
}

function looksLikeReleaseFollowUp(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (WF_ID_RE.test(t)) return true;
  if (/\b(next\s+step|continue|advance|go\s+on|move\s+on|proceed\s+without)\b/i.test(t)) {
    return true;
  }
  if (/\bskip\b.{0,40}\b(tag|ticket|qa|deploy|step|this|creation)\b/i.test(t)) return true;
  if (/\b(use|change|set|update)\s+(the\s+)?(title|summary|tag|version)\b/i.test(t)) return true;
  if (/\btitle\s*[:=]\s*["']?.+/i.test(t)) return true;
  if (/\brevise\b|\bpending\b/i.test(t) && /\b(title|summary|tag|ticket)\b/i.test(t)) return true;
  return false;
}

function looksLikeStatusOnly(text) {
  return /\b(status|where\s+are\s+we|progress)\b/i.test(String(text || ''));
}

function looksLikeSkipPending(text) {
  const t = String(text || '').trim();
  return (
    /\bskip\b.{0,40}\b(tag|ticket|qa|deploy|step|this|creation)\b/i.test(t) ||
    /\bskip\s+(it|that|this)\b/i.test(t) ||
    /\bwithout\s+(a\s+)?(git\s+)?tag\b/i.test(t)
  );
}

function looksLikeRevisePending(text) {
  const t = String(text || '').trim();
  return (
    /\b(use|change|set|update|rename)\s+(the\s+)?(title|summary|tag|version)\b/i.test(t) ||
    /\btitle\s*[:=]/i.test(t) ||
    /\brevise\b/i.test(t) ||
    /\b(change|edit|update|revise|set|use)\b.{0,40}\b(qa|deploy|tag|version|checklist|rollback|risk|security|summary)\b/i.test(
      t
    ) ||
    /\b(skip|remove)\s+(the\s+)?(git\s+)?tag\b/i.test(t)
  );
}

function looksLikeDraftRevision(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\bdraft\b/i.test(t) && /\b(change|edit|revise|update|set|use|skip)\b/i.test(t)) {
    return true;
  }
  return looksLikeRevisePending(t);
}

function toToolResult(outcome) {
  const text = outcome?.text || 'OK';
  const pause = outcome?.result?.pause || null;
  const pendingArgs = outcome?.result?.pendingArgs || null;
  return {
    text,
    envelope: envelopeFromRaw('wf-release', {
      ok: true,
      workflowId: outcome?.ctx?.workflow?.id,
      state: outcome?.ctx?.workflow?.state,
      pause,
      pendingArgs,
      warnings: outcome?.ctx?.warnings || [],
      export_paths: outcome?.ctx?.export_paths || null,
    }),
    raw: outcome,
    pause,
    pendingArgs,
    ctx: outcome?.ctx,
  };
}

/**
 * If the engine paused for confirmation, stage via the shared confirm gate.
 */
async function maybeStage(outcome, discordCtx) {
  const base = toToolResult(outcome);
  if (base.pause !== 'confirmation' || !base.pendingArgs) {
    return base;
  }
  return stageOrExecute(
    'wf_release_execute_pending',
    base.pendingArgs,
    discordCtx || {},
    async (confirmedArgs) => {
      const executed = await engine.executePending(confirmedArgs);
      return maybeStage(executed, discordCtx);
    },
    { domainLabel: 'GitHub/Jira (release workflow)' }
  );
}

async function rejectIfReleasePending(pending, discordCtx) {
  if (!pending || pending.tool !== 'wf_release_execute_pending') return null;
  const id = pending.args?.workflowId;
  if (!id) return null;
  try {
    const outcome = await engine.rejectPending(id, { reason: 'user_cancelled' });
    return maybeStage(outcome, discordCtx);
  } catch (err) {
    return { text: `Release pending cleared, but workflow reject failed: ${err.message}` };
  }
}

function releaseIntentFromContext(text, ctx = {}) {
  const t = String(text || '').trim();
  const pendingIsRelease =
    ctx.hasPending && String(ctx.pendingTool || '').startsWith('wf_release_');
  const workflowId =
    extractWorkflowId(t) ||
    ctx.lastWorkflowId ||
    (pendingIsRelease && ctx.pendingArgs?.workflowId) ||
    null;

  if (pendingIsRelease) {
    return {
      domain: 'release',
      mode: 'mutate',
      needsConfirm: true,
      budget: 'fast',
      confidence: 'high',
      reason: 'release-pending-followup',
      workflowId: workflowId || null,
      skipPending: looksLikeSkipPending(t),
      revisePending: looksLikeRevisePending(t),
      advance: /\b(next\s+step|continue|advance|go\s+on|move\s+on)\b/i.test(t),
      draft: looksLikeDraftRequest(t),
      approveDraft: /\b(approve|execute|run)\b.{0,30}\bdraft\b|\bapprove\s+(the\s+)?(release\s+)?draft\b/i.test(t),
    };
  }

  if (looksLikeReleaseStart(t) || looksLikeDraftRequest(t)) {
    const statusOnly = looksLikeStatusOnly(t) && !/\b(start|prepare|create|begin|draft)\b/i.test(t);
    const draft = looksLikeDraftRequest(t);
    return {
      domain: 'release',
      mode: statusOnly ? 'lookup' : 'mutate',
      needsConfirm: !statusOnly,
      budget: 'fast',
      confidence: 'high',
      reason: draft ? 'release-draft' : statusOnly ? 'release-status' : 'release-workflow',
      workflowId,
      skipTag: /\bskip\s+(the\s+)?(git\s+)?tag\b/i.test(t),
      draft,
      approveDraft: false,
    };
  }

  if (workflowId || looksLikeReleaseFollowUp(t)) {
    // Follow-ups that aren't explicitly release-scoped need a workflow anchor
    const needsAnchor =
      !WF_ID_RE.test(t) &&
      !/\b(wf\s+)?release\b|\bhotfix\b|\bdraft\b/i.test(t);
    if (needsAnchor && !workflowId && !ctx.hasPending && !ctx.lastWorkflowId) {
      return null;
    }
    const statusOnly = looksLikeStatusOnly(t);
    return {
      domain: 'release',
      mode: statusOnly ? 'lookup' : 'mutate',
      needsConfirm: !statusOnly,
      budget: 'fast',
      confidence: workflowId || ctx.lastWorkflowId ? 'high' : 'medium',
      reason: workflowId ? 'release-workflow-id' : 'release-followup',
      workflowId: workflowId || ctx.lastWorkflowId || null,
      skipPending: looksLikeSkipPending(t),
      revisePending: looksLikeRevisePending(t),
      advance: /\b(next\s+step|continue|advance|go\s+on|move\s+on)\b/i.test(t),
      draft: looksLikeDraftRequest(t),
      approveDraft: /\b(approve|execute|run)\b.{0,30}\bdraft\b|\bapprove\s+(the\s+)?(release\s+)?draft\b/i.test(t),
    };
  }

  return null;
}

registry.register({
  id: 'release',

  intent: (text, ctx = {}) => releaseIntentFromContext(text, ctx),

  tools: [
    {
      type: 'function',
      function: {
        name: 'wf_release_start',
        description:
          'Start a release workflow from a PR, Jira key, branch, and/or repository. ALWAYS builds a complete draft first: reads GitHub/Jira and has the LLM populate every checklist field (tag, QA, Deploy, release notes, risk, rollback, etc.) in one pass. No GitHub/Jira writes happen until the user approves the draft; approval stages ONE confirmation that executes all planned writes. Pass skip_tag=true to skip Git tag creation.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Original user phrasing' },
            repo: { type: 'string', description: 'owner/repo' },
            pr: { type: 'integer', description: 'Pull request number' },
            jira: { type: 'string', description: 'Development Jira key' },
            branch: { type: 'string', description: 'Source branch name' },
            skip_tag: {
              type: 'boolean',
              description: 'If true, skip creating the Git tag and continue to QA ticket',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_draft',
        description:
          'Same as wf_release_start — every release always starts as a draft. Build a complete release draft (reads GitHub/Jira, plans tag + QA + Deploy + checklist, all fields populated at once). Does not write until the user approves the draft. Pass id to re-show an existing draft.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            repo: { type: 'string' },
            pr: { type: 'integer' },
            jira: { type: 'string' },
            branch: { type: 'string' },
            skip_tag: { type: 'boolean' },
            id: {
              type: 'string',
              description: 'Optional existing workflow id to re-show draft for',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_revise_draft',
        description:
          'Edit a release draft (tag, QA/Deploy titles, skip_tag, checklist fields) and re-show the full draft with all step descriptions. Does not execute writes. Use this for any change request after a draft is shown.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tag: { type: 'string' },
            skip_tag: { type: 'boolean' },
            qa_summary: { type: 'string', description: 'New QA ticket title/summary' },
            deploy_summary: { type: 'string', description: 'New Deployment ticket title/summary' },
            summary: {
              type: 'string',
              description: 'Alias for qa_summary when changing the QA ticket title',
            },
            release_summary: { type: 'string' },
            technical_summary: { type: 'string' },
            feature_group: { type: 'string', description: 'Product release feature group, or N/A' },
            software_stack_changes: { type: 'string', description: 'Stack/dependency changes, or N/A' },
            snyk_security: { type: 'string', description: 'Snyk security scan findings' },
            rollback_plan: { type: 'string' },
            risk: { type: 'string' },
            security: { type: 'string' },
            customer_impact: { type: 'string' },
            monitoring_owner: { type: 'string' },
            github_link: { type: 'string' },
            message: { type: 'string', description: 'Tag annotation message' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_approve_draft',
        description:
          'Approve the release draft and stage ONE confirmation covering ALL planned GitHub/Jira writes (tag → QA ticket → Deployment ticket). HARD-GATED: nothing is written until the user confirms (confirm_pending). On confirmation every step executes in order, then the workflow validates and exports automatically.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_status',
        description: 'Show status of a release workflow by id.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Workflow id (wf-…)' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_advance',
        description:
          'Resume a paused release workflow to the next pause (after a cancel or failure fix). Use when the user says continue / next step.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Workflow id (wf-…)' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_execute_pending',
        description:
          'Execute the approved release draft (all planned writes: tag, QA ticket, deployment ticket). HARD-GATED until user confirms.',
        parameters: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            type: {
              type: 'string',
              description: 'Always execute_draft',
            },
            payload: { type: 'object' },
          },
          required: ['workflowId', 'type'],
        },
      },
    },
  ],

  tasks: {
    'wf-release-start': {
      execute: async (payload) => {
        const outcome = await engine.start(payload);
        return {
          workflowId: outcome.ctx.workflow.id,
          state: outcome.ctx.workflow.state,
          text: outcome.text,
          pause: outcome.result?.pause,
          pendingArgs: outcome.result?.pendingArgs,
        };
      },
      format: (raw) => raw?.text || JSON.stringify(raw, null, 2),
    },
    'wf-release-status': {
      execute: async (payload) => {
        const outcome = await engine.status(payload.id || payload.workflowId);
        return { workflowId: outcome.ctx.workflow.id, state: outcome.ctx.workflow.state, text: outcome.text };
      },
      format: (raw) => raw?.text || JSON.stringify(raw, null, 2),
    },
    'wf-release-advance': {
      execute: async (payload) => {
        const outcome = await engine.advance(payload.id || payload.workflowId);
        return {
          workflowId: outcome.ctx.workflow.id,
          state: outcome.ctx.workflow.state,
          text: outcome.text,
          pause: outcome.result?.pause,
          pendingArgs: outcome.result?.pendingArgs,
        };
      },
      format: (raw) => raw?.text || JSON.stringify(raw, null, 2),
    },
  },

  toolHandlers: {
    wf_release_start: async (args, discordCtx) => {
      const outcome = await engine.start(args || {});
      return maybeStage(outcome, discordCtx);
    },
    wf_release_draft: async (args, discordCtx) => {
      if (args?.id) {
        const loaded = await engine.load(args.id);
        if (loaded.workflow?.mode === 'draft' && loaded.workflow.state === 'DRAFT_REVIEW') {
          const { formatDraft } = require('../workflows/wfRelease/draft');
          return toToolResult({
            ctx: loaded,
            text: formatDraft(loaded),
            result: { pause: 'draft' },
          });
        }
      }
      const outcome = await engine.start(args || {});
      return maybeStage(outcome, discordCtx);
    },
    wf_release_revise_draft: async (args) => {
      const outcome = await engine.reviseDraft(args.id, args);
      return toToolResult(outcome);
    },
    wf_release_approve_draft: async (args, discordCtx) => {
      const outcome = await engine.approveDraft(args.id);
      return maybeStage(outcome, discordCtx);
    },
    wf_release_status: async (args) => {
      const outcome = await engine.status(args.id);
      return toToolResult(outcome);
    },
    wf_release_advance: async (args, discordCtx) => {
      const outcome = await engine.advance(args.id);
      return maybeStage(outcome, discordCtx);
    },
    wf_release_execute_pending: async (args, discordCtx) =>
      stageOrExecute(
        'wf_release_execute_pending',
        args,
        discordCtx || {},
        async (confirmedArgs) => {
          const executed = await engine.executePending(confirmedArgs);
          return maybeStage(executed, discordCtx);
        },
        { domainLabel: 'GitHub/Jira (release workflow)' }
      ),
  },

  promptPack: (intent, opts) => {
    const confirmOn = opts.confirmOn !== false;
    return [
      'WF Release workflow rules (CRITICAL):',
      '- ONLY call these tools: wf_release_start, wf_release_draft, wf_release_revise_draft, wf_release_approve_draft, wf_release_status, wf_release_advance, wf_release_execute_pending, confirm_pending, cancel_pending.',
      '- NEVER invent tool names (no wf_release_next, wf_release_propose, or similar).',
      '- Do NOT call github_create_tag or jira_create directly for a release flow.',
      '- Standard flow: request → draft → user reviews → revise as needed → user approves → confirm → ALL writes execute, then validate + export automatically.',
      '- EVERY release always starts as a draft (wf_release_start / wf_release_draft are equivalent): reads GitHub/Jira, then the LLM fills every checklist field in one pass. NO writes happen at this stage. Present the entire draft text to the user (all planned steps + descriptions + checklist).',
      '- Always plan NEW QA and Deployment tickets. Never reuse, skip, or attach an existing QA/Deploy ticket from Jira links or a previous release — even if matching tickets already exist.',
      '- After a draft is shown, ANY change request (tag, skip tag, QA/Deploy titles, checklist fields) → call wf_release_revise_draft with the workflow id and the fields to change, then show the updated full draft.',
      '- When the user approves the draft, call wf_release_approve_draft. This stages ONE confirmation covering ALL writes (tag → QA ticket → Deployment ticket). After confirm_pending, every step runs in order and the workflow finishes on its own.',
      '- cancel_pending returns to the draft without writing (already-executed steps are kept).',
      '- Show workflow id and state from tool results.',
      '- When mentioning ANY Jira ticket (dev, QA, deploy), ALWAYS include the full Jira browse URL exactly as shown in tool output — never a bare ticket key. Never invent or alter URLs.',
      '- Never invent checklist fields, ticket keys, or tag names — only use tool evidence.',
      confirmOn
        ? '- Draft execution is HARD-GATED until confirm_pending on a later turn.'
        : '- Confirmation disabled: draft execution runs immediately on approval.',
      intent.draft ? '- This turn looks like a DRAFT request — use wf_release_draft.' : '',
      intent.approveDraft ? '- User is approving a draft — use wf_release_approve_draft with the workflow id.' : '',
      intent.workflowId ? `- Active workflow id hint: ${intent.workflowId}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.domain !== 'release') return;
    const t = String(userText || '');
    const idHint = intent.workflowId || extractWorkflowId(t);
    const startingFresh = looksLikeReleaseStart(t) || looksLikeDraftRequest(t);
    // After a draft is presented there is usually no confirm pending — prefer draft revise
    const preferDraftRevise =
      /\bdraft\b/i.test(t) ||
      intent.draft ||
      (idHint && !opts.hasPending && looksLikeDraftRevision(t));

    if (intent.mode === 'confirm' && opts.hasPending) {
      pushTool('confirm_pending', 'If user confirmed, execute the staged release action');
      pushTool('cancel_pending', 'If user declined, cancel and advance when appropriate');
      return;
    }

    if (intent.approveDraft || /\bapprove\s+(the\s+)?(release\s+)?draft\b/i.test(t)) {
      pushTool('wf_release_approve_draft', 'Stage full draft execution for confirmation');
      return;
    }

    if (intent.draft || looksLikeDraftRequest(t)) {
      if (idHint && /\b(change|edit|revise|update|set|use|skip)\b/i.test(t)) {
        pushTool('wf_release_revise_draft', 'Apply draft edits and re-show draft');
      } else {
        pushTool('wf_release_draft', 'Build or show the full release draft');
      }
      return;
    }

    // New release request wins over skip/revise follow-up heuristics
    if (startingFresh) {
      pushTool('wf_release_start', 'Start release workflow from user source');
      if (intent.skipTag || /\bskip\s+(the\s+)?(git\s+)?tag\b/i.test(t)) {
        pushGuidance('skip_tag', 'Pass skip_tag=true on wf_release_start');
      }
      return;
    }

    if ((intent.skipPending || looksLikeSkipPending(t)) && (opts.hasPending || idHint)) {
      if (idHint && /\b(skip|remove)\s+(the\s+)?(git\s+)?tag\b/i.test(t)) {
        pushTool('wf_release_revise_draft', 'Skip tag on draft (skip_tag=true) and re-show');
        return;
      }
      if (opts.hasPending) {
        pushTool('cancel_pending', 'Cancel staged execution and return to the draft');
      } else {
        pushTool('wf_release_revise_draft', 'Skip the step on the draft and re-show');
      }
      return;
    }

    if (intent.revisePending || looksLikeRevisePending(t) || preferDraftRevise) {
      pushTool('wf_release_revise_draft', 'Update draft fields and re-show full plan');
      return;
    }

    if (intent.advance || /\b(next\s+step|continue|advance)\b/i.test(t)) {
      pushTool('wf_release_advance', 'Continue workflow to the next pause');
      return;
    }

    if (intent.mode === 'lookup' || looksLikeStatusOnly(t)) {
      pushTool('wf_release_status', 'Show release workflow status');
      return;
    }

    if (/\b(approve|looks good|lgtm)\b/i.test(t) && !opts.hasPending) {
      pushTool('wf_release_approve_draft', 'Approve the draft — stages one confirmation for all writes');
      return;
    }

    if (idHint) {
      pushTool('wf_release_status', 'Check current release workflow state');
      pushGuidance('followup', 'Then advance, revise_draft, or approve_draft as needed');
      return;
    }

    pushTool('wf_release_start', 'Start release workflow from user source');
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (!String(tool || '').startsWith('wf_release_')) return;
    const d = envelope?.data || {};
    if (Array.isArray(out)) {
      out.push({
        type: 'release_workflow',
        workflowId: d.workflowId,
        state: d.state,
        snippet: text ? String(text).slice(0, 400) : null,
      });
    }
  },
});

module.exports = {
  rejectIfReleasePending,
  formatExportSummary,
  extractWorkflowId,
  looksLikeSkipPending,
  looksLikeRevisePending,
  looksLikeDraftRequest,
  looksLikeDraftRevision,
  releaseIntentFromContext,
  WF_ID_RE,
};
