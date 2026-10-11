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
          'Prefer a short title, useful body, and a stable notification_key so updates replace prior alerts. ' +
          'Optional: subtitle, expanded_body, channel, urgency, silent, deep_link, image_url, actions, style. ' +
          'Use style progress only for ongoing work. Do not spam.',
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
            subtitle: { type: 'string', description: 'Header subtext, e.g. Jira · PROJ-123.' },
            expanded_body: { type: 'string', description: 'Longer text when the shade expands.' },
            category: {
              type: 'string',
              enum: ['msg', 'email', 'reminder', 'progress', 'recommendation', 'status', 'promo'],
            },
            channel: {
              type: 'string',
              enum: ['urgent', 'default', 'digest', 'progress', 'quiet'],
              description: 'Maps to Android NotificationChannel ids (curtis_*).',
            },
            urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
            silent: { type: 'boolean', description: 'No sound / heads-up.' },
            notification_key: {
              type: 'string',
              description: 'Stable id so later pushes replace this alert instead of stacking.',
            },
            group_key: { type: 'string', description: 'Bundle related alerts.' },
            deep_link: {
              type: 'string',
              description: 'App path or URL to open on tap.',
            },
            image_url: { type: 'string', description: 'https image URL for BigPicture.' },
            large_icon_url: { type: 'string', description: 'https large icon URL.' },
            related_notification_id: {
              type: 'string',
              description: 'Inbound phone notification id this alert refers to.',
            },
            when: { type: 'string', description: 'ISO event time.' },
            expires_at: { type: 'string', description: 'ISO auto-dismiss time.' },
            only_alert_once: {
              type: 'boolean',
              description: 'Update without re-buzzing (default true when notification_key set).',
            },
            style: {
              type: 'string',
              enum: ['default', 'big_text', 'big_picture', 'progress'],
            },
            progress: {
              type: 'object',
              description: 'Required when style is progress.',
              properties: {
                current: { type: 'integer', minimum: 0 },
                max: { type: 'integer', minimum: 1 },
                indeterminate: { type: 'boolean' },
              },
            },
            short_critical_text: {
              type: 'string',
              description: 'Short status-bar chip text (Android 16 Live Updates).',
            },
            ongoing: { type: 'boolean' },
            request_promoted: {
              type: 'boolean',
              description: 'Request Live Update promotion (requires ongoing).',
            },
            actions: {
              type: 'array',
              maxItems: 3,
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    enum: ['open', 'snooze', 'mark_done', 'open_draft', 'view_issue'],
                  },
                  label: { type: 'string' },
                },
                required: ['id', 'label'],
              },
            },
            data: {
              type: 'object',
              description: 'Optional extra string map (do not use curtis_* keys).',
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
      '- Prefer a stable notification_key so progress updates replace the previous alert.',
      '- Use channel/urgency for interrupt level; silent for digests; deep_link to open the right screen.',
      '- Optional actions: open, snooze, mark_done, open_draft, view_issue (max 3).',
      '- style progress + ongoing only for in-progress work; request_promoted only with ongoing (Android 16 Live Updates).',
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
