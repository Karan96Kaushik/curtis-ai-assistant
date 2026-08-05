const browserManager = require('../integrations/browserManager');
const { confidenceFromSource } = require('../util/taskResult');

function log(...args) {
  console.error('[web-search]', ...args);
}

function attachEnvelope(payload) {
  const confidence = confidenceFromSource(payload.source);
  return {
    ...payload,
    ok: payload.source !== 'mock' || Boolean(payload.warning),
    confidence,
    data: {
      query: payload.query,
      results: payload.results,
      count: payload.count,
    },
  };
}

/**
 * Normalize organic results from Serper / SerpAPI-style payloads.
 * @param {any} data
 * @returns {{ title: string, link: string, snippet: string }[]}
 */
function normalizeOrganic(data) {
  const organic =
    data?.organic ||
    data?.organic_results ||
    data?.results ||
    [];

  if (!Array.isArray(organic)) return [];

  return organic
    .map((item) => ({
      title: String(item.title || item.name || '').trim(),
      link: String(item.link || item.url || item.href || '').trim(),
      snippet: String(item.snippet || item.description || item.content || '').trim(),
    }))
    .filter((r) => r.title && r.link)
    .slice(0, 3);
}

function mockResults(query) {
  const q = encodeURIComponent(query);
  return [
    {
      title: `[mock] Search result 1 for "${query}"`,
      link: `https://example.com/search?q=${q}&r=1`,
      snippet: 'Mock result — set SERP_API_KEY for live Serper/SerpAPI results.',
    },
    {
      title: `[mock] Search result 2 for "${query}"`,
      link: `https://example.com/search?q=${q}&r=2`,
      snippet: 'Fallback used because no SERP API key was configured.',
    },
    {
      title: `[mock] Search result 3 for "${query}"`,
      link: `https://example.com/search?q=${q}&r=3`,
      snippet: 'Replace with a real key in .env to enable live web search.',
    },
  ];
}

/**
 * Best-effort scrape of DuckDuckGo HTML results (no API key).
 * @param {string} query
 * @returns {Promise<{ title: string, link: string, snippet: string }[]>}
 */
async function scrapeDuckDuckGo(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const { status, data } = await browserManager.fastFetch(url, {
    Accept: 'text/html',
  });

  if (status >= 400 || typeof data !== 'string') {
    throw new Error(`DuckDuckGo scrape failed (HTTP ${status})`);
  }

  const results = [];
  // result__a = title link; result__snippet = snippet
  const blockRe =
    /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)/gi;

  let match;
  while ((match = blockRe.exec(data)) !== null && results.length < 3) {
    const link = decodeHtml(match[1]).trim();
    const title = stripTags(match[2]).trim();
    const snippet = stripTags(match[3]).trim();
    if (title && link) {
      results.push({ title, link, snippet });
    }
  }

  return results;
}

function stripTags(html) {
  return decodeHtml(String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Live search via Serper (preferred) or SerpAPI using SERP_API_KEY.
 * @param {string} query
 * @param {string} apiKey
 */
async function searchWithApi(query, apiKey) {
  const provider = String(process.env.SERP_PROVIDER || 'serper').toLowerCase();

  if (provider === 'serpapi' || provider === 'serp-api') {
    const { status, data } = await browserManager.fastFetch(
      'https://serpapi.com/search.json',
      {},
      {
        params: {
          engine: 'google',
          q: query,
          api_key: apiKey,
          num: '3',
        },
      }
    );
    if (status >= 400) {
      throw new Error(`SerpAPI error (HTTP ${status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    }
    return { source: 'serpapi', results: normalizeOrganic(data) };
  }

  // Default: Serper.dev
  const { status, data } = await browserManager.fastFetch(
    'https://google.serper.dev/search',
    {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    {
      method: 'POST',
      data: { q: query, num: 3 },
    }
  );

  if (status >= 400) {
    throw new Error(`Serper error (HTTP ${status}): ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return { source: 'serper', results: normalizeOrganic(data) };
}

/**
 * Web search task — top 3 results { title, link, snippet }.
 * @param {{ query?: string, q?: string }} payload
 */
async function webSearchTask(payload = {}) {
  const query = String(payload.query || payload.q || '').trim();
  if (!query) {
    throw new Error('Missing required field: query');
  }

  const apiKey = process.env.SERP_API_KEY?.trim();

  try {
    if (apiKey) {
      log(`source=api query="${query}"`);
      const { source, results } = await searchWithApi(query, apiKey);
      if (results.length) {
        return attachEnvelope({ query, source, count: results.length, results });
      }
      log('API returned 0 organic results; falling back');
    } else {
      log('No SERP_API_KEY; trying DuckDuckGo scrape');
    }

    try {
      const scraped = await scrapeDuckDuckGo(query);
      if (scraped.length) {
        return attachEnvelope({
          query,
          source: 'duckduckgo-html',
          count: scraped.length,
          results: scraped,
        });
      }
    } catch (err) {
      log(`DuckDuckGo fallback failed: ${err.message || err}`);
    }

    const results = mockResults(query);
    return attachEnvelope({
      query,
      source: 'mock',
      count: results.length,
      results,
      warning: 'Results are mock/fallback — set SERP_API_KEY for live search.',
    });
  } catch (err) {
    log(`search failed: ${err.message || err}`);
    // Never crash the bot loop — return a soft failure payload.
    const results = mockResults(query);
    return attachEnvelope({
      query,
      source: 'mock',
      count: results.length,
      results,
      warning: `Live search failed (${err.message || err}); returned mock results.`,
      error: err.message || String(err),
    });
  }
}

function formatResult(result) {
  const lines = [
    `Web search: "${result.query}" (source: ${result.source}, confidence: ${result.confidence || confidenceFromSource(result.source)})`,
  ];
  if (result.warning) {
    lines.push(`Warning: ${result.warning}`);
  }
  if (!result.results?.length) {
    lines.push('No results.');
    return lines.join('\n');
  }
  result.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.link}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  return lines.join('\n');
}

module.exports = webSearchTask;
module.exports.formatResult = formatResult;
module.exports.normalizeOrganic = normalizeOrganic;
