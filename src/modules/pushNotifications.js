const registry = require('../core/moduleRegistry');
const push = require('../ai/pushNotifications');

function isWeb() {
  return process.env.CURTIS_SURFACE === 'web';
}

function notAvailable() {
  return {
    text: 'Push notifications are available in the web app only.',
    envelope: {
      ok: false,
      source: 'push-notifications',
      confidence: 'high',
      data: null,
      error: 'web_only',
    },
  };
}

registry.register({
  id: 'push',

  intent: (text) => {
    if (!isWeb()) return;
    const t = String(text || '').trim();
    if (
      !/\b(push( me)?|notify( me)?|send (me )?(a )?(push |phone )?notification|alert( me)?( on)?( my)?( phone)?|ping (my )?phone)\b/i.test(
        t
      )
    ) {
      return;
    }
    return {
      domain: 'push',
      mode: 'mutate',
      needsConfirm: false,
      budget: 'fast',
      confidence: 'high',
      reason: 'push-notification',
    };
  },

  // Always offered on web so the agent can notify after useful work — not confirmation-gated.
  selectTools: () => (isWeb() ? [push.TOOL_NAME] : []),

  tools: [
    {
      type: 'function',
      function: {
        name: push.TOOL_NAME,
        description:
          'Send a push notification to the signed-in user\'s Android app (FCM). ' +
          'Executes immediately — no user confirmation. ' +
          'You choose title and body (and optional data). ' +
          'Use when the user asks to be notified, or when a useful result is ready and a phone alert helps. ' +
          'Do not spam; one clear notification per meaningful event.',
        parameters: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: `Short lock-screen title (max ${push.MAX_TITLE_CHARS} chars).`,
            },
            body: {
              type: 'string',
              description: `Notification body the user will read (max ${push.MAX_BODY_CHARS} chars).`,
            },
            data: {
              type: 'object',
              description:
                'Optional string key/value map for the Android app (deep link, conversation id, etc.). All values must be strings.',
              additionalProperties: { type: 'string' },
            },
          },
          required: ['title', 'body'],
        },
      },
    },
  ],

  toolHandlers: {
    [push.TOOL_NAME]: async (args, discordCtx) => {
      if (!isWeb()) return notAvailable();

      const outcome = await push.sendToUser(discordCtx?.userId, args);
      if (!outcome.ok) {
        return {
          text: `Error: ${outcome.message}`,
          envelope: {
            ok: false,
            source: 'push-notifications',
            confidence: 'high',
            data: null,
            error: 'send_failed',
          },
        };
      }

      const text = push.formatResult(outcome.result, outcome.payload);
      console.log(
        `[push] sent=${outcome.result.sent} failed=${outcome.result.failed} removed=${outcome.result.removed} title=${JSON.stringify(outcome.payload.title)}`
      );
      return {
        text,
        envelope: {
          ok: true,
          source: 'push-notifications',
          confidence: 'high',
          data: {
            ...outcome.result,
            title: outcome.payload.title,
          },
        },
      };
    },
  },

  promptPack: () => {
    if (!isWeb()) return null;
    return [
      'Push notifications (Android):',
      `- Call ${push.TOOL_NAME} with title and body when the user asks to be notified, or when a phone alert is clearly useful.`,
      '- Executes immediately. Do not ask for confirmation and do not call confirm_pending for this tool.',
      '- You decide the wording. Keep title short; put the useful detail in body.',
      '- Optional data is for the Android app only (string values). Prefer omitting it unless a deep link or id helps.',
      '- Do not claim a push was delivered unless this tool returned success with sent > 0.',
      '- If no device tokens are registered, tell the user to open the Android app while signed in.',
    ].join('\n');
  },

  buildPlan: (intent, _userText, opts, pushTool, pushGuidance) => {
    if (!isWeb() || intent.domain !== 'push') return;
    pushTool(push.TOOL_NAME, 'Send an FCM push to the user\'s Android app immediately');
    pushGuidance('no_confirm', 'Do not ask for confirmation before sending the push');
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (tool !== push.TOOL_NAME) return;
    if (envelope?.ok && envelope.data?.sent > 0) {
      out.push({
        type: 'side_effect',
        value: `Push notification sent (${envelope.data.sent} device(s)): ${envelope.data.title || ''}`.trim(),
      });
    } else if (envelope?.ok === false || /No device tokens/i.test(String(text))) {
      out.push({ type: 'meta', value: String(text).split('\n')[0].slice(0, 160) });
    }
  },
});
