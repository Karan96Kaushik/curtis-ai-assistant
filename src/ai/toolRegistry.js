const registry = require('../core/moduleRegistry');

/**
 * @param {{ confirmOn?: boolean }} opts
 * @returns {object[]}
 */
function buildAllTools(opts = {}) {
  const confirmOn = opts.confirmOn !== false;
  let allTools = registry.getTools();

  if (!confirmOn) {
    allTools = allTools.filter(t => t.function.name !== 'confirm_pending' && t.function.name !== 'cancel_pending');
  }

  const mutatingNames = registry.getMutatingTools();

  return allTools.map(t => {
    if (!mutatingNames.has(t.function.name)) return t;
    const copy = JSON.parse(JSON.stringify(t));
    const gate = confirmOn
      ? 'HARD-GATED: only proposes the change; it applies after the user confirms in a later message.'
      : 'Executes immediately.';
    copy.function.description = `${t.function.description || t.function.name} ${gate}`;
    return copy;
  });
}

/**
 * Tools offered this turn. Each module decides which of its tools fit the
 * intent via `selectTools`; see moduleRegistry.selectTools.
 * @param {object} intent
 * @param {{ confirmOn?: boolean, hasPending?: boolean }} [opts]
 */
function toolsForIntent(intent, opts = {}) {
  const confirmOn = opts.confirmOn !== false;
  const hasPending = Boolean(opts.hasPending);
  const ctx = {
    confirmOn,
    hasPending,
    writes: intent.mode === 'mutate' || intent.mode === 'confirm' || hasPending,
    fallback: intent.domain === 'chat' || intent.confidence === 'low',
  };
  const allowed = registry.selectTools(intent, ctx);
  return buildAllTools(opts).filter(t => allowed.has(t.function.name));
}

module.exports = {
  buildAllTools,
  toolsForIntent,
};
