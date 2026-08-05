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
    /\brevise\b/i.test(t)
  );
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
          'Start a WF release workflow from a PR, Jira key, branch, and/or repository. Runs read-only gathering until the first confirmation or question. Pass skip_tag=true to skip Git tag creation.',
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
            mode: {
              type: 'string',
              enum: ['step', 'draft'],
              description: 'step = confirm each write; draft = gather full plan then one confirmation',
            },
            draft: {
              type: 'boolean',
              description: 'Shortcut for mode=draft',
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
          'Build a complete release draft (reads GitHub/Jira, plans tag + QA + Deploy + checklist). Does not write until the user approves the draft and confirms.',
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
          'Edit a release draft (tag, QA/Deploy titles, skip_tag, checklist fields) and re-show the full draft. Does not execute writes.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tag: { type: 'string' },
            skip_tag: { type: 'boolean' },
            qa_summary: { type: 'string' },
            deploy_summary: { type: 'string' },
            release_summary: { type: 'string' },
            technical_summary: { type: 'string' },
            rollback_plan: { type: 'string' },
            risk: { type: 'string' },
            security: { type: 'string' },
            customer_impact: { type: 'string' },
            monitoring_owner: { type: 'string' },
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
          'Approve the release draft and stage a single execute_draft action. HARD-GATED: nothing is written until the user confirms in a later message (confirm_pending).',
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
          'Advance an existing release workflow to the next pause (after skip/cancel, or to continue auto states). Use when the user says go to the next step / continue.',
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
        name: 'wf_release_skip',
        description:
          'Skip the current pending mutating step (tag / QA / deploy) and continue the workflow. Prefer this (or cancel_pending) when the user says skip tag / skip this step.',
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
        name: 'wf_release_revise_pending',
        description:
          'Revise the staged pending action before confirm (e.g. change QA/Deploy ticket title/summary, or proposed tag). Re-stages for confirmation — does not invent new tool names.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Workflow id (wf-…)' },
            summary: { type: 'string', description: 'New Jira ticket summary/title' },
            tag: { type: 'string', description: 'New tag / version name' },
            message: { type: 'string', description: 'New tag annotation message' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_answer',
        description:
          'Answer, accept suggestion, or skip an unknown checklist field during RESOLVE_UNKNOWN_FIELDS.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            field: { type: 'string' },
            value: { type: 'string' },
            skip: { type: 'boolean' },
            accept: { type: 'boolean', description: 'Accept the suggested value' },
          },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_edit',
        description: 'Edit a ReleaseContext field during REVIEW_RELEASE.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            field: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['id', 'field', 'value'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'wf_release_approve_review',
        description: 'Approve the release checklist review and continue to VALIDATE → EXPORT.',
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
        name: 'wf_release_execute_pending',
        description:
          'Execute the staged release mutating step (create tag, QA ticket, or deployment ticket). HARD-GATED until user confirms.',
        parameters: {
          type: 'object',
          properties: {
            workflowId: { type: 'string' },
            type: {
              type: 'string',
              description: 'create_tag | create_qa_ticket | create_deployment_ticket',
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
      const outcome = await engine.startDraft(args || {});
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
    wf_release_skip: async (args, discordCtx) => {
      const outcome = await engine.rejectPending(args.id, { reason: 'user_skip' });
      return maybeStage(outcome, discordCtx);
    },
    wf_release_revise_pending: async (args, discordCtx) => {
      const outcome = await engine.revisePending(args.id, {
        summary: args.summary,
        qa_summary: args.qa_summary,
        deploy_summary: args.deploy_summary,
        tag: args.tag,
        message: args.message,
        skip_tag: args.skip_tag,
      });
      return maybeStage(outcome, discordCtx);
    },
    wf_release_answer: async (args, discordCtx) => {
      const outcome = await engine.answer(args.id, args);
      return maybeStage(outcome, discordCtx);
    },
    wf_release_edit: async (args) => {
      const outcome = await engine.edit(args.id, args);
      return toToolResult(outcome);
    },
    wf_release_approve_review: async (args, discordCtx) => {
      const outcome = await engine.approveReview(args.id);
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
      '- ONLY call these tools: wf_release_start, wf_release_draft, wf_release_revise_draft, wf_release_approve_draft, wf_release_status, wf_release_advance, wf_release_skip, wf_release_revise_pending, wf_release_answer, wf_release_edit, wf_release_approve_review, wf_release_execute_pending, confirm_pending, cancel_pending.',
      '- NEVER invent tool names (no wf_release_next, wf_release_propose, or similar).',
      '- Do NOT call github_create_tag or jira_create directly for a release flow.',
      '- Prefer wf_release_draft when the user asks for a draft / full plan. Present the entire draft text to the user.',
      '- After draft changes, call wf_release_revise_draft then show the updated draft.',
      '- When the user approves the draft, call wf_release_approve_draft (stages one execute_draft) then wait for confirm_pending on the next turn.',
      '- Step mode: wf_release_start confirms each write separately.',
      '- Skip current mutating step → wf_release_skip (or cancel_pending).',
      '- Show workflow id and state from tool results.',
      '- Never invent checklist fields, ticket keys, or tag names — only use tool evidence.',
      confirmOn
        ? '- Mutating steps / draft execution are HARD-GATED until confirm_pending on a later turn.'
        : '- Confirmation disabled: mutating steps execute immediately.',
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
      if (idHint && /\b(change|edit|revise|update|set|use)\b/i.test(t)) {
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
      if (idHint) pushTool('wf_release_skip', 'Skip current pending step and continue');
      else pushGuidance('need_id', 'Need workflow id for wf_release_skip (from prior turn)');
      if (opts.hasPending) {
        pushTool('cancel_pending', 'Alternate: cancel staged pending (also advances release)');
      }
      return;
    }

    if (intent.revisePending || looksLikeRevisePending(t)) {
      if (/\bdraft\b/i.test(t)) {
        pushTool('wf_release_revise_draft', 'Update draft fields and re-show');
      } else {
        pushTool('wf_release_revise_pending', 'Update pending summary/tag then re-stage for confirm');
      }
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
      pushTool('wf_release_approve_draft', 'If draft mode, approve draft');
      pushTool('wf_release_approve_review', 'If checklist review, approve review');
      return;
    }

    if (/\bskip\b/i.test(t) && /\b(field|unknown|checklist)\b/i.test(t)) {
      pushTool('wf_release_answer', 'Skip an unknown checklist field');
      return;
    }

    if (idHint) {
      pushTool('wf_release_status', 'Check current release workflow state');
      pushGuidance('followup', 'Then advance, skip, revise_draft/revise_pending, or answer as needed');
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
  releaseIntentFromContext,
  WF_ID_RE,
};
