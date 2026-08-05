const registry = require('../core/moduleRegistry');
const webSearchTask = require('../tasks/webSearch');
const webFetchPageTask = require('../tasks/webFetchPage');

function executeTaskDetailed(name, payload) {
  return require('../discord/taskRunner').executeTaskDetailed(name, payload);
}

function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>)"']+/i) ||
    String(text || '').match(/\b(www\.[^\s<>)"']+)/i);
  if (!m) return null;
  let u = m[0].replace(/[.,;:!?)]+$/, '');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function looksLikeOpenPage(text) {
  const t = String(text || '');
  return (
    /\b(open|visit|browse|fetch|scrape|read|load)\b.{0,40}\b(url|page|site|link|website)\b/i.test(t) ||
    /\b(page text|text from (the )?page|contents? of (the )?page|what('s| is) on (this|the) (page|site))\b/i.test(t) ||
    (/\b(open|give me text|get (the )?text|read)\b/i.test(t) && /\b(https?:\/\/|www\.)/i.test(t))
  );
}

registry.register({
  id: 'web',

  intent: (text) => {
    const t = String(text || '').trim();
    const travel = /\b(hotel|hotels|booking\.com|airbnb|accommodation|stay|stays|room rates?|nightly)\b/i.test(t);
    if (travel) return null;

    const url = extractUrl(t);
    if (looksLikeOpenPage(t) || (url && /\b(open|text|page|content|read|fetch|scrape)\b/i.test(t))) {
      return {
        domain: 'web',
        mode: 'research',
        budget: 'heavy',
        confidence: 'high',
        reason: 'web-fetch',
        forceWebFetch: true,
        pageUrl: url,
      };
    }

    if (
      /\b(search (the )?web|google|look up|web search|what is|who is|latest|news about|find (me )?info)\b/i.test(t) ||
      /\b(https?:\/\/|www\.)\b/i.test(t)
    ) {
      // Bare URL with no fetch language → still prefer fetch over search
      if (url) {
        return {
          domain: 'web',
          mode: 'research',
          budget: 'heavy',
          confidence: 'high',
          reason: 'web-fetch',
          forceWebFetch: true,
          pageUrl: url,
        };
      }
      return {
        domain: 'web',
        mode: 'research',
        budget: 'fast',
        confidence: 'high',
        reason: 'web-search',
      };
    }
  },

  tools: [
    {
      type: 'function',
      function: {
        name: 'web_fetch_page',
        description:
          'Open a URL and return readable page text. Tries fast HTTP first, then Playwright for JS-heavy pages. Use when the user asks to open/read/scrape a specific URL.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full http(s) URL to open' },
            mode: {
              type: 'string',
              enum: ['auto', 'fast', 'browser'],
              description: 'auto (default) = fast then Playwright if thin; browser = Playwright only',
            },
            max_chars: { type: 'integer', description: 'Max characters of text to return (default 6000)' },
          },
          required: ['url'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the web for a query and return the top 3 results (title, link, snippet). Not for reading a specific URL — use web_fetch_page for that.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query string' },
          },
          required: ['query'],
        },
      },
    },
  ],

  tasks: {
    'web-search': {
      execute: webSearchTask,
      format: webSearchTask.formatResult,
    },
    'web-fetch-page': {
      execute: webFetchPageTask,
      format: webFetchPageTask.formatResult,
    },
  },

  toolHandlers: {
    web_search: async (args) => executeTaskDetailed('web-search', { query: args.query }),
    web_fetch_page: async (args) =>
      executeTaskDetailed('web-fetch-page', {
        url: args.url,
        mode: args.mode,
        max_chars: args.max_chars,
      }),
  },

  promptPack: (intent) => {
    return [
      'Web research mode:',
      '- Specific URL / "open … and give me text" → call web_fetch_page (NOT web_search).',
      '- Open questions / "look up X" → web_search.',
      '- You DO have Playwright via web_fetch_page (mode=auto|browser). Never claim you cannot open pages.',
      '- Summarize page text for Discord; cite the URL from the tool result.',
      '- If source is mock or confidence is low, disclose that clearly.',
      intent?.pageUrl ? `- Target URL for this turn: ${intent.pageUrl}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  },

  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.domain !== 'web' && intent.mode !== 'research') return;
    if (intent.domain === 'travel' || intent.mode === 'compare') return;

    if (intent.forceWebFetch || intent.reason === 'web-fetch') {
      pushTool('web_fetch_page', `Open ${intent.pageUrl || 'the URL'} and extract page text`);
      return;
    }
    pushTool('web_search', 'Gather top web results for the query');
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (tool === 'web_search' && envelope.data?.results) {
      for (const r of envelope.data.results) {
        out.push({ type: 'link', title: r.title, url: r.link, snippet: r.snippet });
      }
      if (envelope.source === 'mock' || envelope.confidence === 'low') {
        out.push({ type: 'meta', value: 'search_results_are_mock_or_low_confidence' });
      }
    }
    if (tool === 'web_fetch_page') {
      const d = envelope.data || {};
      out.push({
        type: 'page',
        url: d.url,
        title: d.title,
        chars: d.chars,
        excerpt: String(d.text || '').slice(0, 800),
      });
      if (!envelope.ok) {
        out.push({ type: 'meta', value: `page_fetch_failed: ${envelope.error || 'unknown'}` });
      }
    }
  },
});
