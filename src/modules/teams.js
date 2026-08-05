const fs = require('fs');
const path = require('path');
const registry = require('../core/moduleRegistry');
const extensionBridge = require('../integrations/extensionBridge');

const TEAMS_URL = 'https://teams.cloud.microsoft/';
const TEAMS_UI_SPEC_PATH = path.join(__dirname, '..', '..', 'ms-teams-ui.spec.md');

let teamsUiSpecCache = null;

function loadTeamsUiSpec() {
  if (teamsUiSpecCache != null) return teamsUiSpecCache;
  try {
    teamsUiSpecCache = fs.readFileSync(TEAMS_UI_SPEC_PATH, 'utf8').trim();
  } catch (err) {
    console.warn('[teams] could not load ms-teams-ui.spec.md:', err.message || err);
    teamsUiSpecCache = '';
  }
  return teamsUiSpecCache;
}

function offlineEnvelope(error) {
  return {
    text: `Firefox extension offline: ${error || 'not connected'}. Load the Curtis extension and ensure the bot is running.`,
    envelope: {
      ok: false,
      source: 'firefox-ext',
      confidence: 'none',
      data: null,
      error: error || 'not_connected',
    },
  };
}

async function rpc(method, params = {}) {
  if (!extensionBridge.isConnected()) {
    return offlineEnvelope('Firefox extension is not connected');
  }
  const { ok, result, error } = await extensionBridge.callSafe(method, params);
  if (!ok) return offlineEnvelope(error);

  const text =
    typeof result?.text === 'string'
      ? result.text
      : JSON.stringify(result, null, 2);

  return {
    text,
    envelope: {
      ok: result?.ok !== false,
      source: 'firefox-ext',
      confidence: result?.confidence || 'medium',
      data: result?.data !== undefined ? result.data : result,
      warning: result?.warning,
      error: result?.error,
    },
  };
}

registry.register({
  id: 'teams',

  intent: (text) => {
    const t = String(text || '').trim();
    if (!/\b(teams|ms teams|microsoft teams)\b/i.test(t)) return null;

    const isWrite = /\b(open|send|post|reply|type|click)\b/i.test(t) &&
      !/\b(read|list|show|what|messages?)\b/i.test(t);

    return {
      domain: 'teams',
      mode: isWrite ? 'mutate' : 'research',
      budget: 'heavy',
      confidence: 'high',
      reason: isWrite ? 'teams-write' : 'teams-read',
    };
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'teams_open',
        description:
          'Focus an existing Microsoft Teams Firefox tab/window if one is already open; only open a new tab when none exists. Runs immediately (not confirm-gated). Prefer before list/read.',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description:
                'URL only used when no Teams tab exists yet (defaults to teams.cloud.microsoft). Ignored if a Teams tab is already open.',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'teams_list_chats',
        description:
          'List recent chats/channels from the Teams list pane (DOM scrape). Prefer teams_open first so an existing Teams tab is focused.',
        parameters: {
          type: 'object',
          properties: {
            max: { type: 'integer', description: 'Max chats to return (default 20)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'teams_read_messages',
        description:
          'Read recent messages from the Teams main content stage (message pane). Optional chat_title selects a list-pane item first.',
        parameters: {
          type: 'object',
          properties: {
            chat_title: {
              type: 'string',
              description: 'Optional chat/channel title to open/select first',
            },
            max: { type: 'integer', description: 'Max messages (default 30)' },
          },
        },
      },
    },
  ],

  toolHandlers: {
    teams_open: async (args) => {
      const url = String(args.url || '').trim() || TEAMS_URL;
      // Focus/open is immediate — no confirm gate (click/type stay gated via browser_*)
      return rpc('teams.open', { url });
    },
    teams_list_chats: async (args) =>
      rpc('teams.listChats', { max: args.max || 20 }),
    teams_read_messages: async (args) =>
      rpc('teams.readMessages', {
        chatTitle: args.chat_title,
        max: args.max || 30,
      }),
  },

  promptPack: (intent, opts) => {
    const spec = loadTeamsUiSpec();
    const rules = [
      'Microsoft Teams (via Firefox extension) rules:',
      '- Call teams_open immediately when the user wants Teams open/focused — do NOT ask for confirmation first; the tool runs right away.',
      '- teams_open reuses any open Teams tab/window; it only creates a tab if none exist. Never open a duplicate.',
      '- If teams_open says the Firefox extension is offline, tell the user to load/reconnect the Curtis add-on — do not claim a Jira problem.',
      '- Prefer stable selectors from the Teams UI spec below: data-tid / data-bi-id, then aria-label / role.',
      '- Chat names are the TEXT CONTENT of span[id^=title-chat-list-item_] — NEVER span[title="…"]. To open/read a chat use teams_read_messages with chat_title, or browser_click with text="Chat Name".',
      '- Layout regions: App Bar (data-control-name=app-bar-*), List Pane (treeitem data-item-type=chat + title-chat-list-item_ spans), Message Stage (chat-pane-message / message-pane), Compose (role=textbox), Send (data-tid=send-button).',
      '- Long threads are virtualized — only visible DOM messages exist; say so if history looks incomplete.',
      '- Disclose scrape limits / empty results; never invent chat names or message text.',
    ].join('\n');

    if (!spec) return rules;
    return `${rules}\n\n--- Teams UI automation spec (authoritative for selectors) ---\n${spec}`;
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.domain !== 'teams' && intent.domain !== 'mixed') return;
    pushGuidance(
      'teams_focus_existing',
      'Use teams_open first — focuses existing Teams tab/window; never open a duplicate'
    );
    if (/\bopen\b/i.test(userText) || intent.mode === 'mutate') {
      pushTool('teams_open', 'Focus existing Teams tab or open only if none exists');
    }
    if (/\b(list|chats?|channels?)\b/i.test(userText)) {
      pushTool('teams_list_chats', 'List recent chats from Teams list pane');
    }
    if (/\b(messages?|read|what.*(said|wrote))\b/i.test(userText)) {
      pushTool('teams_read_messages', 'Read recent messages from Teams message stage');
    }
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (!String(tool).startsWith('teams_')) return;
    const d = envelope.data;
    if (d && (d.reused === true || d.opened === false)) {
      out.push({ type: 'teams_focus', tabId: d.tabId, url: d.url, reused: true });
    }
    if (Array.isArray(d?.chats)) {
      for (const c of d.chats.slice(0, 30)) {
        out.push({ type: 'teams_chat', title: c.title, preview: c.preview });
      }
    }
    if (Array.isArray(d?.messages)) {
      for (const m of d.messages.slice(0, 40)) {
        out.push({
          type: 'teams_message',
          author: m.author,
          text: m.text,
          time: m.time,
        });
      }
    }
    if (envelope.ok === false) {
      out.push({ type: 'teams_error', value: envelope.error || text.slice(0, 120) });
    }
  },
});
