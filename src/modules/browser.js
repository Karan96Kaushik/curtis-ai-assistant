const registry = require('../core/moduleRegistry');
const extensionBridge = require('../integrations/extensionBridge');
const { stageOrExecute } = require('../util/mutatingGate');

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
      confidence: result?.confidence || 'high',
      data: result?.data !== undefined ? result.data : result,
      warning: result?.warning,
      error: result?.error,
    },
  };
}

const WRITE_TOOLS = new Set([
  'browser_open_tab',
  'browser_navigate',
  'browser_click',
  'browser_type',
]);

function looksBrowser(text) {
  const t = String(text || '');
  return (
    /\b(my browser|firefox|current tab|active tab|open (a )?tab|list tabs|browser status)\b/i.test(t) ||
    /\b(click|type into|fill|navigate)\b.{0,40}\b(tab|page|button|field|input)\b/i.test(t) ||
    /\bin (my |the )?browser\b/i.test(t)
  );
}

registry.register({
  id: 'browser',

  intent: (text) => {
    const t = String(text || '').trim();
    if (/\bteams\b/i.test(t) && !/\bbrowser\b/i.test(t)) return null;
    if (!looksBrowser(t)) return null;

    const isWrite =
      /\b(click|type|fill|navigate|open tab|open (a |the )?page)\b/i.test(t) &&
      !/\b(read|list|status|what('s| is) on)\b/i.test(t);

    return {
      domain: 'browser',
      mode: isWrite ? 'mutate' : 'research',
      budget: 'heavy',
      confidence: 'high',
      reason: isWrite ? 'browser-write' : 'browser-read',
    };
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'browser_status',
        description:
          'Check whether the Firefox extension is connected to Curtis and summarize connection state.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_list_tabs',
        description: 'List open Firefox tabs (title, url, active). Requires the Curtis Firefox extension.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_open_tab',
        description:
          'Open a URL in Firefox (or focus an existing matching tab). Runs immediately. Teams URLs reuse an existing Teams tab.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to open' },
            activate: { type: 'boolean', description: 'Focus the tab (default true)' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_navigate',
        description:
          'Navigate a Firefox tab to a URL. Runs immediately.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            tab_id: { type: 'integer', description: 'Optional tab id; defaults to active tab' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_read_page',
        description:
          'Read visible text from the active (or specified) Firefox tab. Optional CSS selector to scope.',
        parameters: {
          type: 'object',
          properties: {
            tab_id: { type: 'integer' },
            selector: { type: 'string', description: 'Optional CSS selector' },
            max_chars: { type: 'integer', description: 'Max characters (default 8000)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_click',
        description:
          'Click an element in the active Firefox tab. Prefer CSS selector when stable (data-tid, role). For visible labels (e.g. Teams chat names), pass text= or selector text:"Opsoft Standup" — do NOT invent title="…" attributes; chat titles are text content. HARD-GATED when confirmation is on.',
        parameters: {
          type: 'object',
          properties: {
            selector: {
              type: 'string',
              description:
                'CSS selector, or text:"Label" / text=Label. If CSS like span[title="X"] fails, extension also matches visible text X.',
            },
            text: {
              type: 'string',
              description: 'Visible text to click (preferred for chat names / buttons without stable ids)',
            },
            tab_id: { type: 'integer' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'browser_type',
        description:
          'Type text into an input/textarea matched by CSS selector. HARD-GATED when confirmation is on.',
        parameters: {
          type: 'object',
          properties: {
            selector: { type: 'string' },
            text: { type: 'string' },
            clear: { type: 'boolean', description: 'Clear existing value first (default true)' },
            tab_id: { type: 'integer' },
          },
          required: ['selector', 'text'],
        },
      },
    },
  ],

  toolHandlers: {
    browser_status: async () => {
      const connected = extensionBridge.isConnected();
      if (!connected) return offlineEnvelope('Firefox extension is not connected');
      const res = await rpc('browser.status');
      return res;
    },
    browser_list_tabs: async () => rpc('browser.listTabs'),
    browser_open_tab: async (args) =>
      rpc('browser.openTab', {
        url: args.url,
        activate: args.activate !== false,
      }),
    browser_navigate: async (args) =>
      rpc('browser.navigate', {
        url: args.url,
        tabId: args.tab_id,
      }),
    browser_read_page: async (args) =>
      rpc('browser.readPage', {
        tabId: args.tab_id,
        selector: args.selector,
        maxChars: args.max_chars || 8000,
      }),
    browser_click: async (args, ctx) =>
      stageOrExecute(
        'browser_click',
        args,
        ctx,
        () =>
          rpc('browser.click', {
            selector: args.selector,
            text: args.text,
            tabId: args.tab_id,
          }),
        { domainLabel: 'your browser' }
      ),
    browser_type: async (args, ctx) =>
      stageOrExecute(
        'browser_type',
        args,
        ctx,
        () =>
          rpc('browser.type', {
            selector: args.selector,
            text: args.text,
            clear: args.clear !== false,
            tabId: args.tab_id,
          }),
        { domainLabel: 'your browser' }
      ),
  },

  promptPack: (intent, opts) => {
    const confirmOn = opts.confirmOn !== false;
    return [
      'Browser (Firefox extension) rules:',
      '- Use browser_* tools only when the user wants actions in their real Firefox session.',
      '- Prefer browser_read_page / browser_list_tabs / browser_status for reads.',
      '- browser_open_tab / browser_navigate execute immediately (reuse existing Teams/matching tabs when applicable).',
      confirmOn
        ? '- browser_click / browser_type only PROPOSE until confirm_pending.'
        : '- browser_click / browser_type execute immediately.',
      '- If tools report extension offline, tell the user to load the temporary add-on and keep the bot running.',
      '- Do not invent page content — only report tool evidence.',
      '- Never assume text labels are title="" attributes. For labeled UI (Teams chats, buttons), use browser_click text="Exact label" or selector text:"Exact label".',
    ].join('\n');
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.domain !== 'browser' && intent.domain !== 'mixed') return;
    if (intent.mode === 'mutate') {
      pushGuidance('browser_writes', 'Open/navigate immediately; click/type are confirm-gated');
    } else {
      pushTool('browser_status', 'Check extension connection if unsure');
      if (/\btabs?\b/i.test(userText)) pushTool('browser_list_tabs', 'List open tabs');
      if (/\b(read|page|content|what('s| is) on)\b/i.test(userText)) {
        pushTool('browser_read_page', 'Read visible page text');
      }
    }
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (!String(tool).startsWith('browser_')) return;
    if (envelope.data) {
      out.push({ type: 'browser', tool, value: envelope.data });
    }
    if (envelope.ok === false) {
      out.push({ type: 'browser_error', value: envelope.error || text.slice(0, 120) });
    }
  },
});

module.exports = { WRITE_TOOLS };
