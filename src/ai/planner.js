const registry = require('../core/moduleRegistry');

/**
 * L2 — Structured turn plan (rule-based from intent).
 * Tool steps MUST use real tool names only — never invent names like "synthesize".
 */

/**
 * @param {object} intent — from intentRouter.classify
 * @param {string} userText
 * @param {{ hasPending?: boolean }} [opts]
 */
function buildPlan(intent, userText, opts = {}) {
  const goal = summarizeGoal(intent, userText);
  /** @type {{ id: number, action: string, why: string, kind: 'tool'|'guidance' }[]} */
  const steps = [];
  let id = 1;

  const pushTool = (action, why) => {
    // Basic verification: is this tool registered anywhere?
    if (!registry.getToolSchema(action)) {
      throw new Error(`planner: refusing non-tool action "${action}"`);
    }
    steps.push({ id: id++, action, why, kind: 'tool' });
  };

  const pushGuidance = (action, why) => {
    steps.push({ id: id++, action, why, kind: 'guidance' });
  };

  // Give all modules a chance to contribute to the plan
  registry.buildPlanSteps(intent, userText, opts, pushTool, pushGuidance);

  if (intent.confidence === 'low' && steps.length === 0 && !isCapabilityAsk(userText)) {
    pushGuidance(
      'answer_or_think',
      'Prefer a plain-text reply. Optional: call think (scratchpad) — never call synthesize'
    );
  }

  return finalize(goal, steps, stopCondition(intent));
}

function isCapabilityAsk(text) {
  return /\b(what can you do|what do you do|your capabilities|help|how can you help|what are you)\b/i.test(
    String(text || '')
  );
}

function finalize(goal, steps, stopWhen) {
  return {
    goal,
    steps,
    stopWhen,
    /** Reminder injected into prompts — not a tool. */
    systemAfter:
      'After any needed tool calls, STOP and reply with plain assistant text (or empty content). ' +
      'A separate system synthesis pass writes the final user reply. ' +
      'NEVER call a tool named synthesize, finalize, or answer — those are not tools.',
  };
}

function summarizeGoal(intent, userText) {
  const clipped = String(userText || '').trim().slice(0, 160);
  return `[${intent.domain}/${intent.mode}] ${clipped || '(empty)'}`;
}

function stopCondition(intent) {
  if (intent.mode === 'agenda') return 'jira_my_issues ran; system will synthesize agenda';
  if (intent.mode === 'lookup' && intent.domain === 'jira') return 'jira_my_issues ran this turn';
  if (intent.domain === 'travel') return 'web_check_prices ran or dates missing asked once';
  if (intent.domain === 'web') return 'web_search ran (disclose mock/low confidence)';
  if (intent.mode === 'mutate') return 'mutation staged or executed; user informed';
  return 'plain-text reply or real tool calls only; no invented tool names';
}

function formatPlanForPrompt(plan) {
  if (!plan) return 'No plan.';
  const lines = [
    `Goal: ${plan.goal}`,
    `Stop when: ${plan.stopWhen}`,
    'Steps (tool = call that exact function name; guidance = instruction only, NOT a tool):',
  ];
  for (const s of plan.steps) {
    if (s.kind === 'tool') {
      lines.push(`  ${s.id}. [TOOL] ${s.action} — ${s.why}`);
    } else {
      lines.push(`  ${s.id}. [GUIDANCE — not a tool] ${s.action}: ${s.why}`);
    }
  }
  if (plan.systemAfter) {
    lines.push('', `System (not a tool): ${plan.systemAfter}`);
  }
  return lines.join('\n');
}

module.exports = {
  buildPlan,
  formatPlanForPrompt,
  isCapabilityAsk,
};
