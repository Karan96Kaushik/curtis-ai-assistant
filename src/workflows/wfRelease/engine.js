const store = require('./store');
const {
  STATES,
  createReleaseContext,
  audit,
  setState,
} = require('./context');
const { parseStartInput } = require('./helpers');
const {
  setField,
  markSkipped,
  listUnresolved,
} = require('./fields');
const {
  handlers,
  executeCreateTag,
  executeCreateQa,
  executeCreateDeploy,
} = require('./states');
const { formatReviewMessage } = require('./states/checklist');
const { formatDraft, applyDraftEdits, ensureDraft, isDraftMode } = require('./draft');

const MAX_AUTO_STEPS = 40;

function sanitizeForPersist(ctx) {
  // Keep ephemeral caches that help resume; drop error stacks size if huge
  if (ctx._last_error?.stack && ctx._last_error.stack.length > 2000) {
    ctx._last_error.stack = ctx._last_error.stack.slice(0, 2000);
  }
  return ctx;
}

function persist(ctx) {
  return store.write(sanitizeForPersist(ctx));
}

function statusText(ctx) {
  const r = ctx.release || {};
  const lines = [
    `Workflow: ${ctx.workflow.id}`,
    `State: ${ctx.workflow.state}`,
    `Repository: ${r.repository || '—'}`,
    `PR: ${r.source_pr || '—'}`,
    `Branch: ${r.source_branch || '—'}`,
    `Dev Jira: ${r.development_ticket || '—'}`,
    `QA: ${r.qa_ticket || '—'}`,
    `Deploy: ${r.deployment_ticket || '—'}`,
    `Version: ${r.previous_version || '—'} → ${r.next_version || '—'}`,
    `Tag created: ${r.github_tag_created ? 'yes' : 'no'}`,
  ];
  if (ctx.pending_action) {
    lines.push(`Pending: ${ctx.pending_action.type}`);
  }
  if (ctx.workflow?.mode === 'draft') {
    lines.push('Mode: draft');
  }
  if (ctx.unknown_fields?.length) {
    lines.push(`Unknown fields: ${ctx.unknown_fields.join(', ')}`);
  }
  if (ctx.warnings?.length) {
    lines.push(`Warnings (${ctx.warnings.length}): ${ctx.warnings.slice(0, 5).join('; ')}`);
  }
  if (ctx.user_prompt) {
    lines.push(`Prompt: ${ctx.user_prompt.prompt}`);
  }
  return lines.join('\n');
}

/**
 * Run state handlers until pause, complete, or max steps.
 */
async function runUntilPause(ctx) {
  const messages = [];
  let last = null;

  for (let i = 0; i < MAX_AUTO_STEPS; i += 1) {
    const state = ctx.workflow.state;
    const handler = handlers[state];
    if (!handler) {
      last = { pause: 'failed', message: `No handler for state ${state}` };
      break;
    }

    last = (await handler(ctx)) || {};
    if (last.message) messages.push(last.message);

    if (last.pause || last.done || last.continue === false) {
      break;
    }
    if (!last.continue) {
      // Handler transitioned but didn't signal continue — stop to avoid loops
      if (ctx.workflow.state === state) break;
      // state changed without continue flag — keep going
    }
  }

  persist(ctx);

  return {
    ctx,
    result: last || {},
    messages,
    text: [statusText(ctx), '', ...(messages.length ? messages : [])].filter(Boolean).join('\n\n'),
  };
}

/**
 * Start a new release workflow.
 * @param {object} input — { text, repo, pr, jira, branch, mode, skip_tag }
 */
async function start(input = {}) {
  const parsed = parseStartInput(input);
  const ctx = createReleaseContext({
    repository: parsed.repository,
    source_pr: parsed.source_pr,
    source_branch: parsed.source_branch,
    development_ticket: parsed.development_ticket,
  });
  const wantDraft =
    input.mode === 'draft' ||
    parsed.draft === true ||
    input.draft === true;
  ctx.workflow.mode = wantDraft ? 'draft' : 'step';
  ensureDraft(ctx);
  if (parsed.skip_tag) {
    ctx.release.tag_skipped = true;
    ctx._skip_tag = true;
  }
  audit(ctx, 'started', { input: parsed, mode: ctx.workflow.mode });
  persist(ctx);
  return runUntilPause(ctx);
}

/** Convenience alias for draft-mode start. */
async function startDraft(input = {}) {
  return start({ ...input, mode: 'draft', draft: true });
}

async function load(id) {
  const ctx = store.read(id);
  if (!ctx) throw new Error(`Release workflow not found: ${id}`);
  return ctx;
}

async function status(id) {
  const ctx = await load(id);
  return {
    ctx,
    text: statusText(ctx),
    result: { pause: ctx.workflow.state === STATES.COMPLETE ? 'complete' : 'status' },
  };
}

async function advance(id) {
  const ctx = await load(id);
  if (ctx.workflow.state === STATES.WAITING_FOR_CONFIRMATION) {
    return {
      ctx,
      text: `${statusText(ctx)}\n\nWaiting for confirmation — confirm or cancel the pending action.`,
      result: {
        pause: 'confirmation',
        pendingArgs: ctx.pending_action
          ? {
              workflowId: ctx.workflow.id,
              type: ctx.pending_action.type,
              payload: ctx.pending_action.payload,
            }
          : null,
      },
    };
  }
  return runUntilPause(ctx);
}

/**
 * Answer or skip an unknown field.
 */
async function answer(id, { field, value, skip, accept } = {}) {
  const ctx = await load(id);
  const target = field || ctx.user_prompt?.field;
  if (!target) {
    return {
      ctx,
      text: `${statusText(ctx)}\n\nNo unknown field pending.`,
      result: { pause: 'user_input' },
    };
  }

  if (skip) {
    markSkipped(ctx, target);
    audit(ctx, 'field_skipped', { field: target });
  } else if (accept && ctx.user_prompt?.suggestion) {
    setField(ctx, target, ctx.user_prompt.suggestion, {
      confidence: 'high',
      source: 'user_accept',
    });
    audit(ctx, 'field_accepted', { field: target });
  } else if (value != null && value !== '') {
    setField(ctx, target, value, { confidence: 'high', source: 'user' });
    audit(ctx, 'field_answered', { field: target });
  } else {
    return {
      ctx,
      text: `${statusText(ctx)}\n\nProvide value, accept=true, or skip=true for ${target}.`,
      result: { pause: 'user_input', question: ctx.user_prompt },
    };
  }

  ctx.user_prompt = null;
  ctx.unknown_fields = listUnresolved(ctx);
  setState(ctx, STATES.RESOLVE_UNKNOWN_FIELDS);
  persist(ctx);
  return runUntilPause(ctx);
}

async function edit(id, { field, value } = {}) {
  const ctx = await load(id);
  if (!field) throw new Error('edit requires field');
  setField(ctx, field, value, { confidence: 'high', source: 'user_edit' });
  audit(ctx, 'field_edited', { field });
  if (ctx.workflow.state !== STATES.REVIEW_RELEASE) {
    setState(ctx, STATES.REVIEW_RELEASE);
  }
  persist(ctx);
  return {
    ctx,
    text: formatReviewMessage(ctx),
    result: { pause: 'review' },
  };
}

async function approveReview(id) {
  const ctx = await load(id);
  audit(ctx, 'review_approved');
  setState(ctx, STATES.VALIDATE);
  persist(ctx);
  return runUntilPause(ctx);
}

/**
 * Execute a confirmed pending mutating action, then continue the machine.
 */
async function executePending({ workflowId, type, payload } = {}) {
  const ctx = await load(workflowId);
  const actionType = type || ctx.pending_action?.type;
  const actionPayload = payload || ctx.pending_action?.payload;
  if (!actionType) {
    throw new Error('No pending release action to execute');
  }

  let execResult;
  try {
    if (actionType === 'create_tag') {
      execResult = await executeCreateTag(ctx, actionPayload || {});
    } else if (actionType === 'create_qa_ticket') {
      execResult = await executeCreateQa(ctx, actionPayload || {});
    } else if (actionType === 'create_deployment_ticket') {
      execResult = await executeCreateDeploy(ctx, actionPayload || {});
    } else if (actionType === 'link_jira') {
      // Linking step removed — clear and continue
      ctx.pending_action = null;
      setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
      execResult = { text: 'Jira linking skipped (step removed).' };
    } else if (actionType === 'execute_draft') {
      execResult = await executeDraftSteps(ctx);
    } else {
      throw new Error(`Unknown pending action type: ${actionType}`);
    }
  } catch (err) {
    ctx._last_error = {
      reason: err.message || String(err),
      stack: err.stack || null,
      tool: actionType,
    };
    setState(ctx, STATES.FAILED);
    persist(ctx);
    const recovered = await runUntilPause(ctx);
    return {
      ...recovered,
      text: [`Execute failed: ${err.message}`, recovered.text].join('\n\n'),
    };
  }

  persist(ctx);
  const continued = await runUntilPause(ctx);
  return {
    ctx: continued.ctx,
    text: [execResult?.text, continued.text].filter(Boolean).join('\n\n'),
    result: continued.result,
    messages: [execResult?.text, ...(continued.messages || [])].filter(Boolean),
  };
}

/**
 * User rejected / skipped the pending action — advance to the next state when possible.
 */
async function rejectPending(id, { reason } = {}) {
  const ctx = await load(id);
  const pending = ctx.pending_action;
  audit(ctx, 'pending_rejected', { type: pending?.type, reason });
  ctx.pending_action = null;

  if (pending?.type === 'create_tag') {
    ctx.warnings.push('Tag creation skipped by user');
    ctx.release.tag_skipped = true;
    // Keep proposed next_version for tickets/checklist even without creating the tag
    if (pending.payload?.tag && !ctx.release.next_version) {
      ctx.release.next_version = pending.payload.tag;
    }
    setState(ctx, STATES.CREATE_QA_TICKET);
  } else if (pending?.type === 'create_qa_ticket') {
    ctx.warnings.push('QA ticket creation skipped by user');
    setState(ctx, STATES.CREATE_DEPLOYMENT_TICKET);
  } else if (pending?.type === 'create_deployment_ticket') {
    ctx.warnings.push('Deployment ticket creation skipped by user');
    setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
  } else if (pending?.type === 'link_jira') {
    ctx.warnings.push('Jira linking skipped (step removed)');
    setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
  } else if (pending?.type === 'execute_draft') {
    ctx.warnings.push('Draft execution cancelled by user');
    setState(ctx, STATES.DRAFT_REVIEW);
    persist(ctx);
    return {
      ctx,
      text: `${statusText(ctx)}\n\nDraft execution cancelled. Draft is still available to revise or approve.\n\n${formatDraft(ctx)}`,
      result: { pause: 'draft' },
    };
  } else {
    setState(ctx, ctx.workflow.resume_state || STATES.REVIEW_RELEASE);
  }

  persist(ctx);
  return runUntilPause(ctx);
}

/**
 * Patch the staged pending action (e.g. change QA ticket summary) and re-stage.
 * @param {string} id
 * @param {{ summary?: string, tag?: string, message?: string, payload?: object }} patch
 */
async function revisePending(id, patch = {}) {
  const ctx = await load(id);

  // Draft-mode edits use the same entry point when no single pending step is staged
  if (isDraftMode(ctx) && (!ctx.pending_action || ctx.pending_action.type === 'execute_draft')) {
    return reviseDraft(id, patch);
  }

  if (!ctx.pending_action) {
    throw new Error(`No pending action on workflow ${id} to revise`);
  }

  const payload = { ...(ctx.pending_action.payload || {}) };
  if (patch.payload && typeof patch.payload === 'object') {
    Object.assign(payload, patch.payload);
  }
  if (patch.summary != null) payload.summary = String(patch.summary);
  if (patch.qa_summary != null) payload.summary = String(patch.qa_summary);
  if (patch.deploy_summary != null) payload.summary = String(patch.deploy_summary);
  if (patch.tag != null) {
    payload.tag = String(patch.tag);
    ctx.release.next_version = payload.tag;
  }
  if (patch.message != null) payload.message = String(patch.message);

  ctx.pending_action.payload = payload;
  audit(ctx, 'pending_revised', { type: ctx.pending_action.type, patch });
  setState(ctx, STATES.WAITING_FOR_CONFIRMATION, {
    resume: ctx.workflow.resume_state || ctx.workflow.previous_state,
  });
  persist(ctx);

  const pendingArgs = getPendingStagingArgs(ctx);
  return {
    ctx,
    text: [
      statusText(ctx),
      '',
      `Revised pending ${ctx.pending_action.type}. Confirm to execute, or revise/cancel again.`,
      pendingArgs?.payload?.summary ? `Summary: ${pendingArgs.payload.summary}` : null,
      pendingArgs?.payload?.tag ? `Tag: ${pendingArgs.payload.tag}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    result: { pause: 'confirmation', pendingArgs },
    messages: ['Pending action revised'],
  };
}

async function reviseDraft(id, patch = {}) {
  const ctx = await load(id);
  if (!isDraftMode(ctx)) {
    throw new Error(`Workflow ${id} is not in draft mode`);
  }
  applyDraftEdits(ctx, patch);
  // Keep planned ticket summaries in sync with version if tag changed
  if (patch.tag) {
    const qa = (ctx.draft?.steps || []).find((s) => s.type === 'create_qa_ticket' && s.payload);
    const dep = (ctx.draft?.steps || []).find((s) => s.type === 'create_deployment_ticket' && s.payload);
    if (qa?.payload && !patch.qa_summary) {
      qa.payload.summary = `[QA] Release ${ctx.release.next_version} — ${ctx.release.component || ctx.release.repository || 'release'}`;
      qa.description = `Create Jira ${qa.payload.issueType} in ${qa.payload.projectKey} with summary "${qa.payload.summary}".`;
    }
    if (dep?.payload && !patch.deploy_summary) {
      dep.payload.summary = `[Deploy] Release ${ctx.release.next_version} — ${ctx.release.component || ctx.release.repository || 'release'}`;
      dep.description = `Create Jira ${dep.payload.issueType} in ${dep.payload.projectKey} with summary "${dep.payload.summary}".`;
    }
  }
  ctx.pending_action = null;
  setState(ctx, STATES.DRAFT_REVIEW);
  audit(ctx, 'draft_revised', { patch });
  persist(ctx);
  return {
    ctx,
    text: formatDraft(ctx),
    result: { pause: 'draft' },
  };
}

/**
 * Approve the draft → stage a single execute_draft pending action for confirm.
 */
async function approveDraft(id) {
  const ctx = await load(id);
  if (!isDraftMode(ctx)) {
    throw new Error(`Workflow ${id} is not in draft mode`);
  }
  ensureDraft(ctx);
  const steps = (ctx.draft.steps || []).filter((s) => !s.skip && !s.reuse && s.payload);
  const payload = {
    steps: (ctx.draft.steps || []).map((s) => ({
      type: s.type,
      skip: s.skip,
      reuse: s.reuse,
      reuse_key: s.reuse_key,
      payload: s.payload,
      title: s.title,
    })),
  };
  ctx.pending_action = { type: 'execute_draft', payload };
  setState(ctx, STATES.WAITING_FOR_CONFIRMATION, { resume: STATES.DRAFT_REVIEW });
  audit(ctx, 'draft_approve_staged', { stepCount: steps.length });
  persist(ctx);

  const summaryLines = [
    'Approve & execute release draft (all writes in one confirmation)',
    `- Workflow: ${ctx.workflow.id}`,
    `- Writes to run: ${steps.length}`,
    ...steps.map((s) => `  • ${s.title || s.type}`),
    '',
    formatDraft(ctx),
  ];

  return {
    ctx,
    text: summaryLines.join('\n'),
    result: {
      pause: 'confirmation',
      pendingArgs: {
        workflowId: ctx.workflow.id,
        type: 'execute_draft',
        payload,
      },
    },
  };
}

/**
 * Run all draft mutating steps, then VALIDATE → EXPORT.
 */
async function executeDraftSteps(ctx) {
  const draft = ensureDraft(ctx);
  const lines = ['Executing approved release draft…'];

  for (const step of draft.steps || []) {
    if (step.skip || step.reuse) {
      if (step.reuse && step.reuse_key) {
        if (step.type === 'create_qa_ticket') ctx.release.qa_ticket = step.reuse_key;
        if (step.type === 'create_deployment_ticket') ctx.release.deployment_ticket = step.reuse_key;
      }
      lines.push(`- ${step.title || step.type}: skipped/reused`);
      continue;
    }
    if (!step.payload) {
      lines.push(`- ${step.title || step.type}: no payload, skipped`);
      continue;
    }

    if (step.type === 'create_tag') {
      const result = await executeCreateTag(ctx, step.payload);
      lines.push(result.text);
    } else if (step.type === 'create_qa_ticket') {
      const result = await executeCreateQa(ctx, step.payload);
      lines.push(result.text);
    } else if (step.type === 'create_deployment_ticket') {
      const result = await executeCreateDeploy(ctx, step.payload);
      lines.push(result.text);
    } else {
      lines.push(`- Unknown step type ${step.type}, skipped`);
    }
  }

  ctx.pending_action = null;
  // Leave draft mode for post-execute validate/export
  ctx.workflow.mode = 'step';
  setState(ctx, STATES.VALIDATE);
  audit(ctx, 'draft_executed');
  return { text: lines.join('\n') };
}

function getPendingStagingArgs(ctx) {
  if (!ctx?.pending_action) return null;
  return {
    workflowId: ctx.workflow.id,
    type: ctx.pending_action.type,
    payload: ctx.pending_action.payload,
  };
}

module.exports = {
  start,
  startDraft,
  status,
  advance,
  answer,
  edit,
  approveReview,
  approveDraft,
  reviseDraft,
  executePending,
  rejectPending,
  revisePending,
  load,
  runUntilPause,
  statusText,
  getPendingStagingArgs,
  STATES,
};
