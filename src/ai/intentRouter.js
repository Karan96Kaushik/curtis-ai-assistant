const registry = require('../core/moduleRegistry');
const pendingActions = require('./pendingActions');
require('../modules/index'); // ensure modules are loaded

/**
 * @param {string} text
 * @param {{
 *   hasPending?: boolean,
 *   isConfirmation?: boolean,
 *   isCancellation?: boolean,
 *   pendingTool?: string,
 *   pendingArgs?: object,
 *   lastWorkflowId?: string|null,
 * }} [ctx]
 */
function classify(text, ctx = {}) {
  const t = String(text || '').trim();
  const pendingDomain = ctx.hasPending
    ? pendingActions.domainFromTool(ctx.pendingTool)
    : null;

  // Confirm/cancel must follow the pending tool's domain (not always Jira).
  if (ctx.hasPending && (ctx.isConfirmation || ctx.isCancellation)) {
    return {
      domain: pendingDomain || 'chat',
      mode: 'confirm',
      needsConfirm: true,
      budget: 'fast',
      confidence: 'high',
      reason: ctx.isCancellation ? 'cancel-pending' : 'confirm-pending',
      pendingTool: ctx.pendingTool || null,
      workflowId: ctx.pendingArgs?.workflowId || ctx.lastWorkflowId || null,
    };
  }

  // Sticky release domain while a release pending action is staged — even for
  // follow-ups like "next step", "use title X", "skip tag" that lack the word "release".
  if (pendingDomain === 'release') {
    const releaseMod = require('../modules/release');
    const sticky = releaseMod.releaseIntentFromContext(t, ctx);
    if (sticky) return sticky;
    return {
      domain: 'release',
      mode: 'mutate',
      needsConfirm: true,
      budget: 'fast',
      confidence: 'high',
      reason: 'release-sticky-pending',
      pendingTool: ctx.pendingTool || null,
      workflowId: ctx.pendingArgs?.workflowId || ctx.lastWorkflowId || null,
    };
  }

  // Ask the registry first
  const matched = registry.matchIntent(t, ctx);
  if (matched) {
    return matched;
  }

  // Fallback: release follow-ups with workflow id even without pending
  const releaseMod = require('../modules/release');
  const followUp = releaseMod.releaseIntentFromContext(t, ctx);
  if (followUp && followUp.reason !== 'release-workflow') {
    return followUp;
  }

  // Fallback to chat if no module matches
  return {
    domain: 'chat',
    mode: 'chat',
    needsConfirm: false,
    budget: 'fast',
    confidence: 'low',
    reason: 'chat',
  };
}

module.exports = {
  classify,
};
