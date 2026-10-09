/**
 * WF Release engine — draft-first flow:
 *
 *   1. start()        → read GitHub/Jira, plan tag + QA + Deploy, LLM fills the
 *                       release form → pause at DRAFT_REVIEW (no writes).
 *   2. reviseDraft()  → apply user edits (or regenerate fields with extra
 *                       context) and re-show the draft. Repeat as needed.
 *   3. approveDraft() → step mode (default): stage ONLY the next write.
 *                       runAll: stage one confirmation covering every remaining write.
 *   4. executePending → run the staged write(s). In step mode the next write is
 *                       staged after each one (confirm / skip / edit / run all
 *                       remaining). When nothing is left: VALIDATE → EXPORT →
 *                       COMPLETE, which prints the full release form.
 *
 * Cancelling a staged write (rejectPending) returns to the draft; steps that
 * already executed stay done and are never repeated.
 */

const store = require('./store');
const {
  STATES,
  createReleaseContext,
  audit,
  setState,
} = require('./context');
const { parseStartInput, jiraLink, warn } = require('./helpers');
const {
  handlers,
  executeCreateTag,
  executeCreateQa,
  executeCreateDeploy,
} = require('./states');
const { populateFields } = require('./states/checklist');
const {
  formatDraft,
  formatStepPrompt,
  applyDraftEdits,
  ensureDraft,
  findStep,
  isDraftMode,
  buildExecutionQueue,
  setStepSkipped,
} = require('./draft');

const MAX_AUTO_STEPS = 40;

const EXECUTORS = {
  create_tag: executeCreateTag,
  create_qa_ticket: executeCreateQa,
  create_deployment_ticket: executeCreateDeploy,
};

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
    }
  }

  persist(ctx);

  // A draft or the completed form is self-contained; status lines + planning logs are noise.
  const selfContained = (last?.pause === 'draft' || last?.done) && last.message;
  return {
    ctx,
    result: last || {},
    messages,
    text: selfContained
      ? last.message
      : [statusText(ctx), '', ...(messages.length ? messages : [])].filter(Boolean).join('\n\n'),
  };
}

/**
 * Start a new release workflow. Always begins as a draft: reads GitHub/Jira,
 * plans every write, fills every release-form field, then pauses for review.
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

function isExecuting(ctx) {
  return Boolean(ctx.workflow.executing) && ctx.workflow.state === STATES.WAITING_FOR_CONFIRMATION;
}

/** Stage exactly one write for confirmation. */
function stageStep(ctx, step, texts = []) {
  ctx.workflow.executing = true;
  ctx.workflow.exec_mode = 'step';
  ctx.pending_action = { type: 'execute_step', payload: { step } };
  setState(ctx, STATES.WAITING_FOR_CONFIRMATION, { resume: STATES.DRAFT_REVIEW });
  persist(ctx);
  return {
    ctx,
    text: [...texts, formatStepPrompt(ctx, step)].filter(Boolean).join('\n\n'),
    result: { pause: 'confirmation', pendingArgs: getPendingStagingArgs(ctx) },
  };
}

/** Stage every remaining write behind one confirmation. */
function stageAll(ctx, queue, texts = []) {
  ctx.workflow.executing = true;
  ctx.workflow.exec_mode = 'all';
  ctx.pending_action = { type: 'execute_draft', payload: { steps: queue } };
  setState(ctx, STATES.WAITING_FOR_CONFIRMATION, { resume: STATES.DRAFT_REVIEW });
  persist(ctx);
  return {
    ctx,
    text: [
      ...texts,
      [
        `${queue.length} write(s) will run in order without stopping:`,
        ...queue.map((s, i) => {
          const detail = s.payload?.summary || s.payload?.tag || '';
          return `${i + 1}. ${s.title || s.type}${detail ? ` — ${detail}` : ''}`;
        }),
        '',
        'Confirm to run them now, or cancel to return to the draft.',
      ].join('\n'),
    ]
      .filter(Boolean)
      .join('\n\n'),
    result: { pause: 'confirmation', pendingArgs: getPendingStagingArgs(ctx) },
  };
}

/** Nothing left to write → VALIDATE → EXPORT → COMPLETE (prints the release form). */
async function finishExecution(ctx, texts = []) {
  ctx.pending_action = null;
  ctx.workflow.executing = false;
  audit(ctx, 'draft_execution_complete');
  setState(ctx, STATES.VALIDATE);
  persist(ctx);
  const finished = await runUntilPause(ctx);
  const finalText = finished.result?.done
    ? finished.messages[finished.messages.length - 1]
    : finished.text;
  return {
    ctx: finished.ctx,
    text: [...texts, finalText].filter(Boolean).join('\n\n'),
    result: finished.result,
    messages: [...texts, ...(finished.messages || [])],
  };
}

/** Stage whatever is left in the current execution mode, or finish. */
function continueExecution(ctx, texts = []) {
  const queue = buildExecutionQueue(ctx);
  if (!queue.length) return finishExecution(ctx, texts);
  return ctx.workflow.exec_mode === 'all' ? stageAll(ctx, queue, texts) : stageStep(ctx, queue[0], texts);
}

/**
 * Apply user edits to the draft and re-show it. `regenerate_notes` re-runs the
 * LLM over every field it owns (user-edited fields are kept) with that extra context.
 * Mid-execution, the next write is re-staged so the edit applies to it.
 */
async function reviseDraft(id, patch = {}) {
  const ctx = await load(id);
  if (!isDraftMode(ctx)) {
    throw new Error(`Workflow ${id} is not in draft mode`);
  }
  if (ctx.workflow.state === STATES.COMPLETE) {
    throw new Error(`Workflow ${id} is already complete — start a new release to change it`);
  }
  const executing = isExecuting(ctx);
  const { ignored } = applyDraftEdits(ctx, patch);
  const notes = patch.regenerate_notes != null ? String(patch.regenerate_notes).trim() : '';
  if (notes || patch.regenerate === true) {
    await populateFields(ctx, { notes: notes || undefined });
  }
  audit(ctx, 'draft_revised', { patch, ignored });
  const notesText = ignored.length ? `Not applied:\n${ignored.map((i) => `- ${i}`).join('\n')}` : null;

  if (executing) {
    return continueExecution(ctx, ['Draft updated.', notesText]);
  }

  ctx.pending_action = null;
  ctx.workflow.executing = false;
  setState(ctx, STATES.DRAFT_REVIEW);
  persist(ctx);
  return {
    ctx,
    text: [notesText, formatDraft(ctx)].filter(Boolean).join('\n\n'),
    result: { pause: 'draft' },
  };
}

/**
 * Approve the draft. Default: stage only the first write (step-by-step).
 * runAll: stage one confirmation for every remaining write — also used mid-execution
 * for "run all remaining".
 * @param {string} id
 * @param {{ runAll?: boolean }} [opts]
 */
async function approveDraft(id, { runAll = false } = {}) {
  const ctx = await load(id);
  if (!isDraftMode(ctx)) {
    throw new Error(`Workflow ${id} is not in draft mode`);
  }
  ensureDraft(ctx);
  const queue = buildExecutionQueue(ctx);
  audit(ctx, 'draft_approved', { stepCount: queue.length, runAll });

  if (!queue.length) return finishExecution(ctx, ['Draft approved — no writes left to run.']);
  if (runAll) return stageAll(ctx, queue);
  return stageStep(ctx, queue[0], ['Draft approved — the writes will run one at a time.']);
}

async function runStep(ctx, step, texts) {
  const current = findStep(ctx, step.type);
  if (!current || current.done || current.skip || !current.payload) {
    texts.push(`${step.title || step.type} is no longer pending — skipped.`);
    return true;
  }
  try {
    const res = await EXECUTORS[current.type](ctx, current.payload);
    if (res?.text) texts.push(res.text);
    persist(ctx);
    return true;
  } catch (err) {
    warn(ctx, `${current.title || current.type} failed: ${err.message}`);
    audit(ctx, 'draft_execution_failed', { step: current.type, error: err.message });
    texts.push(`Failed at "${current.title || current.type}": ${err.message}`);
    return false;
  }
}

/**
 * Run the confirmed write(s). Each write uses the CURRENT draft payload, so edits made
 * after staging apply.
 */
async function executePending({ workflowId, type } = {}) {
  const ctx = await load(workflowId);
  const actionType = type || ctx.pending_action?.type;
  if (ctx.workflow.state !== STATES.WAITING_FOR_CONFIRMATION || !ctx.pending_action) {
    return {
      ctx,
      text: `Nothing is waiting for confirmation on ${workflowId} (state ${ctx.workflow.state}). Approve the draft again to continue.\n\n${formatDraft(ctx)}`,
      result: { pause: 'draft' },
    };
  }

  const texts = [];
  if (actionType === 'execute_step') {
    const step = ctx.pending_action.payload?.step;
    const ok = await runStep(ctx, step, texts);
    if (!ok) {
      const current = findStep(ctx, step.type);
      texts.push('Confirm to retry, skip it, ask for a change, or cancel to return to the draft.');
      return stageStep(ctx, current, texts);
    }
    return continueExecution(ctx, texts);
  }

  if (actionType === 'execute_draft') {
    for (const step of buildExecutionQueue(ctx)) {
      const ok = await runStep(ctx, step, texts);
      if (!ok) {
        ctx.pending_action = null;
        ctx.workflow.executing = false;
        setState(ctx, STATES.DRAFT_REVIEW);
        persist(ctx);
        return {
          ctx,
          text: [
            ...texts,
            'Completed steps are kept. Revise the draft if needed and approve again to run the remaining steps.',
            '',
            formatDraft(ctx),
          ].join('\n\n'),
          result: { pause: 'draft' },
          messages: texts,
        };
      }
    }
    return finishExecution(ctx, texts);
  }

  throw new Error(`Unknown pending release action: ${actionType || '(none)'}`);
}

/** Skip the staged write and stage the next one (or finish). */
async function skipStep(id) {
  const ctx = await load(id);
  const step = ctx.pending_action?.payload?.step;
  if (!isExecuting(ctx) || !step) {
    return {
      ctx,
      text: `No write is staged right now. To skip a planned step, revise the draft (skip_tag / skip_qa / skip_deploy).\n\n${formatDraft(ctx)}`,
      result: { pause: 'draft' },
    };
  }
  setStepSkipped(ctx, step.type, true);
  audit(ctx, 'step_skipped', { step: step.type });
  ctx.workflow.exec_mode = ctx.workflow.exec_mode || 'step';
  return continueExecution(ctx, [`Skipped: ${step.title || step.type}.`]);
}

/**
 * User declined the staged execution — clear it and return to the draft.
 */
async function rejectPending(id, { reason } = {}) {
  const ctx = await load(id);
  audit(ctx, 'pending_rejected', { type: ctx.pending_action?.type, reason });
  ctx.pending_action = null;
  ctx.workflow.executing = false;
  setState(ctx, STATES.DRAFT_REVIEW);
  persist(ctx);
  return {
    ctx,
    text: [
      'Stopped — nothing further was written. Completed steps are kept; revise or approve the draft again to continue.',
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
  skipStep,
  rejectPending,
  load,
  runUntilPause,
  statusText,
  getPendingStagingArgs,
  STATES,
};
