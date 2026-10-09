/**
 * Shared confirm gate for mutating tools (Jira, browser, Teams, …).
 */

const pendingActions = require('../ai/pendingActions');
const config = require('../config');

/**
 * Stage a mutating action when confirmation is on; otherwise run executeFn.
 * @param {string} name tool name
 * @param {object} args
 * @param {{ channelId?: string, userId?: string, _turnId?: string }} discordCtx
 * @param {() => Promise<{ text: string, envelope: object }>} executeFn
 * @param {{ domainLabel?: string }} [opts]
 */
async function stageOrExecute(name, args, discordCtx, executeFn, opts = {}) {
  const confirmOn = config.REQUIRE_CONFIRMATION !== false;
  if (!confirmOn || args.__confirmed) {
    const { __confirmed, ...clean } = args || {};
    return executeFn(clean);
  }

  const summary = pendingActions.buildSummary(name, args);
  pendingActions.set(discordCtx.channelId, discordCtx.userId, {
    tool: name,
    args,
    summary,
    turnId: discordCtx._turnId || null,
  });

  const label = opts.domainLabel || 'the target system';
  const text = [
    `PENDING CONFIRMATION — nothing was changed in ${label} yet (hard gate).`,
    summary,
    '',
    'Show this plan to the user and ask them to confirm or cancel in their next reply.',
    'Do NOT call confirm_pending in this turn — wait for their next message.',
    'When they confirm (yes/confirm), call confirm_pending. When they decline, call cancel_pending.',
  ].join('\n');

  return {
    text,
    envelope: {
      ok: true,
      source: 'pending',
      confidence: 'high',
      data: { staged: true, tool: name, args },
    },
  };
}

/**
 * Execute a confirmed pending tool via its registry handler (with __confirmed set,
 * so stageOrExecute runs it instead of staging again).
 * @param {{ tool: string, args: object, summary: string }} pending
 * @param {{ channelId?: string, userId?: string, _turnId?: string }} discordCtx
 */
async function runConfirmedPending(pending, discordCtx) {
  const name = pending.tool;
  const args = { ...(pending.args || {}), __confirmed: true };

  const registry = require('../core/moduleRegistry');
  const handler = registry.getToolHandler(name);
  if (!handler) {
    return {
      text: `Unknown pending tool: ${name}`,
      envelope: {
        ok: false,
        source: 'policy',
        confidence: 'high',
        data: null,
        error: 'unknown_pending_tool',
      },
    };
  }

  return handler(args, discordCtx);
}

module.exports = {
  stageOrExecute,
  runConfirmedPending,
};
