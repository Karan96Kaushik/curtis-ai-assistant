/**
 * WF Release engine — draft-first flow:
 *
 *   1. start()        → read GitHub/Jira, plan tag + QA + Deploy, LLM fills the
 *                       checklist → pause at DRAFT_REVIEW (no writes).
 *   2. reviseDraft()  → apply user edits, re-show the draft (repeat as needed).
 *   3. approveDraft() → stage ONE confirmation covering ALL remaining writes.
 *   4. executePending({type:'execute_draft'}) → run every write in order, then
 *                       VALIDATE → EXPORT → COMPLETE.
 *
 * Cancelling the confirmation (rejectPending) returns to the draft; steps that
 * already executed stay done and are never repeated.
 */

const store = require('./store');
const {
  STATES,
  createReleaseContext,
  audit,
  setState,
} = require('./context');
const { parseStartInput, ticketSummary, jiraLink } = require('./helpers');
const {
  handlers,
  executeCreateTag,
  executeCreateQa,
  executeCreateDeploy,
} = require('./states');
const {
  formatDraft,
  applyDraftEdits,
  ensureDraft,
  isDraftMode,
  buildExecutionQueue,
} = require('./draft');

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
    `Dev Jira: ${jiraLink(r.development_ticket) || '—'}`,
    `QA: ${jiraLink(r.qa_ticket) || '—'}`,
    `Deploy: ${jiraLink(r.deployment_ticket) || '—'}`,
    `Version: ${r.previous_version || '—'} → ${r.next_version || '—'}`,
    `Tag created: ${r.github_tag_created ? 'yes' : 'no'}`,
  ];
  if (ctx.pending_action) {
    lines.push(`Pending: ${ctx.pending_action.type}`);
  }
  if (ctx.unknown_fields?.length) {
    lines.push(`Unknown fields: ${ctx.unknown_fields.join(', ')}`);
  }
  if (ctx.warnings?.length) {
    lines.push(`Warnings (${ctx.warnings.length}): ${ctx.warnings.slice(0, 5).join('; ')}`);
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
 * Start a new release workflow. Always begins as a draft: reads GitHub/Jira,
 * plans every write, fills every checklist field, then pauses for review.
 * @param {object} input — { text, repo, pr, jira, branch, skip_tag }
 */
async function start(input = {}) {
  const parsed = parseStartInput(input);
  const ctx = createReleaseContext({
    repository: parsed.repository,
    source_pr: parsed.source_pr,
    source_branch: parsed.source_branch,
    development_ticket: parsed.development_ticket,
  });
  ctx.workflow.mode = 'draft';
  ensureDraft(ctx);
  if (parsed.skip_tag) {
    ctx.release.tag_skipped = true;
    ctx._skip_tag = true;
  }
  audit(ctx, 'started', { input: parsed });
  persist(ctx);
  return runUntilPause(ctx);
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

/** Resume a paused workflow (e.g. after a failure fix or blocked validation). */
async function advance(id) {
  const ctx = await load(id);
  if (ctx.workflow.state === STATES.WAITING_FOR_CONFIRMATION) {
    return {
      ctx,
      text: `${statusText(ctx)}\n\nWaiting for confirmation — confirm or cancel the pending action.`,
      result: {
        pause: 'confirmation',
        pendingArgs: getPendingStagingArgs(ctx),
      },
    };
  }
  return runUntilPause(ctx);
}

/** Apply user edits to the draft and re-show it. */
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
      qa.payload.summary = ticketSummary('QA', ctx);
      qa.description = `Create Jira ${qa.payload.issueType} in ${qa.payload.projectKey} with summary "${qa.payload.summary}".`;
    }
    if (dep?.payload && !patch.deploy_summary) {
      dep.payload.summary = ticketSummary('Deploy', ctx);
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
 * Approve the draft → stage a single `execute_draft` action covering ALL
 * remaining writes. One confirmation executes everything.
 */
async function approveDraft(id) {
  const ctx = await load(id);
  if (!isDraftMode(ctx)) {
    throw new Error(`Workflow ${id} is not in draft mode`);
  }
  ensureDraft(ctx);
  const queue = buildExecutionQueue(ctx);

  if (!queue.length) {
    // Nothing left to write — finish up (validate + export).
    audit(ctx, 'draft_approved', { stepCount: 0 });
    setState(ctx, STATES.VALIDATE);
    persist(ctx);
    return runUntilPause(ctx);
  }

  ctx.pending_action = { type: 'execute_draft', payload: { steps: queue } };
  setState(ctx, STATES.WAITING_FOR_CONFIRMATION, { resume: STATES.DRAFT_REVIEW });
  audit(ctx, 'draft_approved', { stepCount: queue.length });
  persist(ctx);

  return {
    ctx,
    text: [
      `Draft approved — ${queue.length} write(s) will run in order:`,
      ...queue.map((s, i) => {
        const detail = s.payload?.summary || s.payload?.tag || '';
        return `${i + 1}. ${s.title || s.type}${detail ? ` — ${detail}` : ''}`;
      }),
      '',
      'Confirm to execute all steps now, or cancel to return to the draft.',
    ].join('\n'),
    result: {
      pause: 'confirmation',
      pendingArgs: getPendingStagingArgs(ctx),
    },
  };
}

/**
 * Execute the confirmed draft: run every queued write in order, then continue
 * VALIDATE → EXPORT → COMPLETE. On a mid-sequence failure, completed steps are
 * kept (marked done) and the workflow returns to the draft for retry.
 */
async function executePending({ workflowId, type, payload } = {}) {
  const ctx = await load(workflowId);
  const actionType = type || ctx.pending_action?.type;
  if (actionType !== 'execute_draft') {
    throw new Error(`Unknown pending release action: ${actionType || '(none)'}`);
  }

  const steps =
    payload?.steps || ctx.pending_action?.payload?.steps || buildExecutionQueue(ctx);
  const executors = {
    create_tag: executeCreateTag,
    create_qa_ticket: executeCreateQa,
    create_deployment_ticket: executeCreateDeploy,
  };

  const texts = [];
  for (const step of steps) {
    const executor = executors[step.type];
    if (!executor) continue;
    try {
      const res = await executor(ctx, step.payload || {});
      if (res?.text) texts.push(res.text);
      persist(ctx);
    } catch (err) {
      ctx.warnings.push(`${step.title || step.type} failed: ${err.message}`);
      ctx.pending_action = null;
      setState(ctx, STATES.DRAFT_REVIEW);
      audit(ctx, 'draft_execution_failed', { step: step.type, error: err.message });
      persist(ctx);
      return {
        ctx,
        text: [
          ...texts,
          `Failed at "${step.title || step.type}": ${err.message}`,
          'Completed steps are kept. Revise the draft if needed and approve again to run the remaining steps.',
          '',
          formatDraft(ctx),
        ].join('\n\n'),
        result: { pause: 'draft' },
        messages: texts,
      };
    }
  }

  ctx.pending_action = null;
  audit(ctx, 'draft_execution_complete', { stepCount: steps.length });
  setState(ctx, STATES.VALIDATE);
  persist(ctx);

  const finished = await runUntilPause(ctx);
  return {
    ctx: finished.ctx,
    text: [texts.join('\n\n'), finished.text].filter(Boolean).join('\n\n'),
    result: finished.result,
    messages: [...texts, ...(finished.messages || [])],
  };
}

/**
 * User declined the staged execution — clear it and return to the draft.
 */
async function rejectPending(id, { reason } = {}) {
  const ctx = await load(id);
  audit(ctx, 'pending_rejected', { type: ctx.pending_action?.type, reason });
  ctx.pending_action = null;
  setState(ctx, STATES.DRAFT_REVIEW);
  persist(ctx);
  return {
    ctx,
    text: [
      'Execution cancelled — nothing further was written. Draft is still available to revise or approve again.',
      '',
      formatDraft(ctx),
    ].join('\n'),
    result: { pause: 'draft' },
  };
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
  status,
  advance,
  approveDraft,
  reviseDraft,
  executePending,
  rejectPending,
  load,
  runUntilPause,
  statusText,
  getPendingStagingArgs,
  STATES,
};
