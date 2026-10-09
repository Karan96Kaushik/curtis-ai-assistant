const registry = require('../core/moduleRegistry');
const pendingActions = require('../ai/pendingActions');
const config = require('../config');
const { runConfirmedPending } = require('../util/mutatingGate');

/** Domains whose modules stage gated writes. */
const GATED_DOMAINS = new Set(['jira', 'github', 'browser', 'teams', 'release']);

registry.register({
  id: 'pending',

  selectTools: (intent, ctx) =>
    ctx.confirmOn && (ctx.hasPending || intent.mode === 'confirm' || GATED_DOMAINS.has(intent.domain))
      ? ['confirm_pending', 'cancel_pending']
      : [],

  tools: [
    {
      type: 'function',
      function: {
        name: 'confirm_pending',
        description:
          'Execute the pending mutating action (Jira, GitHub, browser, Teams, release). Only after explicit user confirmation.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_pending',
        description: 'Cancel the pending mutating action.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],

  toolHandlers: {
    confirm_pending: async (args, discordCtx) => {
      const confirmOn = config.REQUIRE_CONFIRMATION !== false;
      if (!confirmOn) {
        return { text: 'Confirmation is disabled. Mutating tools already execute immediately.', envelope: { ok: true, source: 'policy', confidence: 'high', data: null } };
      }
      const pending = pendingActions.get(discordCtx.channelId, discordCtx.userId);
      if (!pending) return { text: 'No pending action to confirm.', envelope: { ok: false, source: 'policy', confidence: 'high', data: null, error: 'no_pending' } };
      if (pending.turnId && discordCtx._turnId && pending.turnId === discordCtx._turnId) {
        return { text: 'BLOCKED: cannot confirm in the same turn that proposed the action.', envelope: { ok: false, source: 'policy', confidence: 'high', data: null, error: 'same_turn_confirm' } };
      }
      const taken = pendingActions.take(discordCtx.channelId, discordCtx.userId);
      const restore = () =>
        pendingActions.set(discordCtx.channelId, discordCtx.userId, {
          tool: taken.tool,
          args: taken.args,
          summary: taken.summary,
          turnId: null,
        });
      try {
        const result = await runConfirmedPending(taken, discordCtx);
        // Soft-fail (e.g. extension offline): put the pending action back so the user can retry
        if (result?.envelope && result.envelope.ok === false) restore();
        return result;
      } catch (err) {
        restore();
        throw err;
      }
    },
    cancel_pending: async (args, discordCtx) => {
      const confirmOn = config.REQUIRE_CONFIRMATION !== false;
      if (!confirmOn) return { text: 'Confirmation is disabled.', envelope: { ok: true, source: 'policy', confidence: 'high', data: null } };
      const pending = pendingActions.get(discordCtx.channelId, discordCtx.userId);
      if (!pending) return { text: 'No pending action to cancel.', envelope: { ok: false, source: 'policy', confidence: 'high', data: null, error: 'no_pending' } };
      const { rejectIfReleasePending } = require('./release');
      if (pending.tool === 'wf_release_execute_pending') {
        pendingActions.clear(discordCtx.channelId, discordCtx.userId);
        const releaseReject = await rejectIfReleasePending(pending, discordCtx);
        return {
          text: releaseReject?.text || `Skipped pending release action:\n${pending.summary}`,
          envelope: releaseReject?.envelope || {
            ok: true,
            source: 'policy',
            confidence: 'high',
            data: { cancelled: true, advanced: true },
          },
        };
      }
      pendingActions.clear(discordCtx.channelId, discordCtx.userId);
      return { text: `Cancelled pending action:\n${pending.summary}`, envelope: { ok: true, source: 'policy', confidence: 'high', data: { cancelled: true } } };
    },
  },

  buildPlan: (intent, userText, opts, pushTool) => {
    if (intent.mode === 'confirm' && opts.hasPending) {
      pushTool('confirm_pending', 'If user confirmed, execute the staged pending action');
      pushTool('cancel_pending', 'If user declined, cancel the staged action');
    }
  },
});
