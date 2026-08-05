const registry = require('../core/moduleRegistry');

function identityPack() {
  return [
    'You are Curtis, a helpful Discord assistant for Jira, org context, light web research, and (when the Firefox extension is connected) browser/Teams actions at Flexible Power Systems.',
    'Be fluid and proactive: do useful work in one turn when the intent is clear.',
    'Prefer action over clarifying questions unless a required field is missing.',
    'Sound natural — avoid stock closers like "What would you like to do next?".',
  ].join('\n');
}

function fluidPack() {
  return [
    'Fluid conversation:',
    '- Interpret short follow-ups ("all", "broader", "try again", "those", "yes", "details", "pull details") in context.',
    '- Affirmatives after you offered to fetch data → invoke the tool immediately; do not re-offer.',
    '- Prefer a generous useful answer over an empty over-filtered miss.',
    '- Never invent Jira issue types (Story/Epic) unless the user named them.',
    '- Never invent Jira URLs or domains — only paste URL fields from tool results.',
  ].join('\n');
}

function groundingPack() {
  return [
    'Grounding (required):',
    '- Factual claims must come from THIS turn’s tool evidence or Org memory.',
    '- Your capabilities, identity, and rules are provided in Org memory and can be cited without tool evidence.',
    '- Never claim a side effect succeeded unless a write tool in THIS turn returned success.',
    '- If a tool errors or returns mock/low-confidence data, say so plainly.',
    '- If you lack evidence for a named ticket, call jira_get_issue — do not claim it is missing from "the current dataset" and stop.',
    '- Chat history can contradict tools; THIS turn’s tools win. Do not gaslight the user about keys that appeared earlier.',
  ].join('\n');
}

/**
 * Assemble mode packs for this turn’s intent.
 * @param {object} intent
 * @param {{ confirmOn?: boolean }} [opts]
 */
function packsForIntent(intent, opts = {}) {
  const packs = [identityPack(), fluidPack(), groundingPack()];
  
  // Get prompt pack from the module that owns this domain
  const modulePack = registry.getPromptPack(intent.domain, intent, opts);
  if (modulePack) {
    packs.push(modulePack);
  } else if (intent.domain === 'mixed') {
    // If it's a mixed intent, we might want to include multiple packs
    // For now, let's keep it simple, or iterate through modules to see if they apply.
    for (const [id, packFn] of registry.promptPacks.entries()) {
      const pack = packFn(intent, opts);
      if (pack) packs.push(pack);
    }
  }

  return packs.join('\n\n');
}

module.exports = {
  identityPack,
  fluidPack,
  groundingPack,
  packsForIntent,
};
