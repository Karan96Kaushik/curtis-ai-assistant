const registry = require('../core/moduleRegistry');

/** Same set as the agent notification tools. Offered only for a phone intent. */
const NOTIFICATION_TOOLS = [
  'notification_app_stats',
  'search_notifications',
  'notification_digest',
  'get_notification',
  'list_notification_apps',
  'get_more',
  'draft_reply',
];

const searchProperties = {
  app: { type: 'string', description: 'App name or package fragment, e.g. WhatsApp, Gmail, com.whatsapp' },
  exclude_app: { type: 'string', description: 'Omit this app or package from results' },
  sender: { type: 'string', description: 'Notification title or chat/sender name' },
  text: { type: 'string', description: 'Substring in title or body' },
  category: { type: 'string', description: 'Android category fragment, e.g. msg, email, promo' },
  since: { type: 'string', description: 'ISO start time. Default is 7 days ago (or hours, if set)' },
  until: { type: 'string', description: 'ISO end time. Default is now' },
  hours: { type: 'integer', minimum: 1, maximum: 168, description: 'Look back this many hours (1–168). Used when since is omitted' },
  limit: { type: 'integer', minimum: 1, maximum: 40, description: 'Max results, 1–40. Default 20' },
};

/** @type {null | ((name: string, userId: string, args: object) => Promise<string>)} */
let callTool = null;

function configure(fn) {
  callTool = typeof fn === 'function' ? fn : null;
}

function isWeb() {
  return process.env.CURTIS_SURFACE === 'web';
}

function notAvailable() {
  return {
    text: 'Phone notifications are available in the web app only.',
    envelope: {
      ok: false,
      source: 'phone-notifications',
      confidence: 'high',
      data: null,
      error: 'web_only',
    },
  };
}

function readError(message) {
  return {
    text: `Error: ${message}`,
    envelope: {
      ok: false,
      source: 'phone-notifications',
      confidence: 'high',
      data: null,
      error: 'read_failed',
    },
  };
}

function tool(name, description, parameters) {
  return { type: 'function', function: { name, description, parameters } };
}

const toolHandlers = {};
for (const name of NOTIFICATION_TOOLS) {
  toolHandlers[name] = async (args, discordCtx) => {
    if (!isWeb()) return notAvailable();
    if (!callTool) return readError('Phone notifications are not configured on this surface.');
    const userId = discordCtx?.userId;
    if (!userId) return readError('No signed-in user for this turn.');
    try {
      const text = await callTool(name, userId, args && typeof args === 'object' ? args : {});
      if (discordCtx) discordCtx._phoneNotificationsRead = true;
      return {
        text: String(text || ''),
        envelope: {
          ok: true,
          source: 'phone-notifications',
          confidence: 'high',
          data: { tool: name },
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return readError(message || 'Could not read phone notifications');
    }
  };
}

registry.register({
  id: 'phone',

  intent: (text) => {
    if (!isWeb()) return;
    const t = String(text || '').trim();
    const asks =
      /\b(notifications?|phone alerts?|lock\s*screen)\b/i.test(t) ||
      /\b(text messages?|sms|otp|one[- ]time (code|password)|verification code)\b/i.test(t) ||
      /\b(on (my )?phone|from (my )?phone)\b/i.test(t);
    if (!asks) return;
    return {
      domain: 'phone',
      mode: 'lookup',
      needsConfirm: false,
      budget: 'fast',
      confidence: 'high',
      reason: 'phone-notifications',
    };
  },

  selectTools: (intent) => (isWeb() && intent.domain === 'phone' ? NOTIFICATION_TOOLS : []),

  tools: [
    tool(
      'notification_app_stats',
      'Per-app notification counts for a time window (hours, or since/until). Default last 24 hours. Use before search_notifications to see which apps are active.',
      {
        type: 'object',
        properties: {
          hours: searchProperties.hours,
          since: { type: 'string', description: 'ISO start time' },
          until: { type: 'string', description: 'ISO end time. Default is now' },
        },
      }
    ),
    tool(
      'search_notifications',
      'Search phone notification previews. Filter by app, exclude_app, sender, text, category, since/until or hours (1–168). Call notification_app_stats first for the time window. Default window is 7 days, default limit 20, max 40. Not full messages.',
      { type: 'object', properties: searchProperties }
    ),
    tool(
      'notification_digest',
      'Counts and top senders for a time window. Compact triage of notification previews.',
      {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'ISO start time' },
          group_by: { type: 'string', enum: ['app', 'sender'] },
        },
        required: ['since'],
      }
    ),
    tool(
      'get_notification',
      'Read the full stored text of one notification by id.',
      {
        type: 'object',
        properties: { id: { type: 'string', description: 'Notification id from search or digest' } },
        required: ['id'],
      }
    ),
    tool(
      'list_notification_apps',
      'List apps that have notification rows for this user.',
      { type: 'object', properties: {} }
    ),
    tool(
      'get_more',
      'Fetch the next page of a previous search_notifications query. Pass the same filters plus offset.',
      {
        type: 'object',
        properties: {
          offset: { type: 'integer', minimum: 0, description: 'Skip this many matches from a previous search' },
          ...searchProperties,
        },
        required: ['offset'],
      }
    ),
    tool(
      'draft_reply',
      'Store a reply draft and a tap-to-open link (mailto or WhatsApp). The user sends it; you cannot send messages.',
      {
        type: 'object',
        properties: {
          notification_id: { type: 'string', description: 'Id of the notification being answered' },
          body: { type: 'string', description: 'Reply text the user will send' },
        },
        required: ['notification_id', 'body'],
      }
    ),
  ],

  toolHandlers,

  promptPack: () => {
    if (!isWeb()) return null;
    return [
      'Phone notifications:',
      '- Call notification_app_stats for the time window first, then search_notifications with app filters.',
      '- Results are truncated previews, not full messages. Use get_notification for one id, and get_more with the same filters to page.',
      '- list_notification_apps lists apps. notification_digest is a compact count view and requires since.',
      '- You cannot send email or WhatsApp. Use draft_reply so the user opens a link and sends it themselves.',
      '- Never claim you saw a notification that these tools did not return. Do not store notification text in memory.',
    ].join('\n');
  },

  buildPlan: (intent, _userText, _opts, pushTool, pushGuidance) => {
    if (!isWeb() || intent.domain !== 'phone') return;
    pushTool('notification_app_stats', 'Count notifications per app for the window before searching');
    pushGuidance(
      'then_search',
      'Then call search_notifications with app filters. Use get_notification for one id and get_more to page.'
    );
  },
});

module.exports = { configure, NOTIFICATION_TOOLS };
