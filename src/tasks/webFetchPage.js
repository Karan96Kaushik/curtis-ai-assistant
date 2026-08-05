const browserManager = require('../integrations/browserManager');
const { withEnvelope, confidenceFromSource } = require('../util/taskResult');

const MAX_CHARS_HARD = 12000;

/**
 * @param {string} raw
 */
function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) {
    u = `https://${u.replace(/^\/\//, '')}`;
  }
  try {
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Rough HTML → readable text (no extra deps).
 * @param {string} html
 */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null;
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return { title, text: s };
}

function decodeEntities(str) {
  return String(str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function truncate(text, maxChars) {
  const t = String(text || '');
  if (t.length <= maxChars) return { text: t, truncated: false };
  return { text: `${t.slice(0, maxChars)}\n…[truncated]`, truncated: true };
}

/**
 * Fast axios fetch of HTML body.
 * @param {string} url
 */
async function fetchFast(url) {
  const res = await browserManager.fastFetch(url, {
    Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  }, { timeoutMs: 20000 });
  const ctype = String(res.headers['content-type'] || res.headers['Content-Type'] || '');
  const data = res.data;
  const html = typeof data === 'string' ? data : data != null ? JSON.stringify(data) : '';
  return { status: res.status, contentType: ctype, html };
}

/**
 * Playwright: load page and extract visible-ish text.
 * @param {string} url
 */
async function fetchBrowser(url) {
  return browserManager.runInBrowser(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise((r) => setTimeout(r, 800));
    const extracted = await page.evaluate(() => {
      const title = document.title || '';
      const root =
        document.querySelector('main') ||
        document.querySelector('article') ||
        document.body;
      const text = (root && root.innerText) || '';
      return { title, text: text.replace(/\n{3,}/g, '\n\n').trim() };
    });
    return extracted;
  });
}

/**
 * Open a URL and return readable page text.
 * @param {{ url: string, mode?: 'auto'|'fast'|'browser', max_chars?: number }} payload
 */
async function webFetchPageTask(payload = {}) {
  const url = normalizeUrl(payload.url || payload.link || payload.href);
  if (!url) {
    throw new Error('Missing or invalid url (expected http(s) URL)');
  }

  let mode = String(payload.mode || 'auto').toLowerCase();
  if (!['auto', 'fast', 'browser'].includes(mode)) mode = 'auto';

  let maxChars = Number(payload.max_chars ?? payload.maxChars ?? 6000);
  if (!Number.isFinite(maxChars) || maxChars < 500) maxChars = 6000;
  maxChars = Math.min(Math.floor(maxChars), MAX_CHARS_HARD);

  /** @type {{ title: string|null, text: string, source: string, status?: number, warning?: string }} */
  let result = { title: null, text: '', source: 'unknown' };

  if (mode === 'fast' || mode === 'auto') {
    try {
      const fast = await fetchFast(url);
      if (fast.status >= 200 && fast.status < 400 && fast.html) {
        const parsed = htmlToText(fast.html);
        const thin = parsed.text.length < 200;
        if (!thin || mode === 'fast') {
          result = {
            title: parsed.title,
            text: parsed.text,
            source: 'axios',
            status: fast.status,
            warning: thin ? 'Fast fetch returned little text; page may be JS-rendered.' : undefined,
          };
        } else {
          result.warning = 'Fast fetch thin; escalating to Playwright';
        }
      } else {
        result.warning = `Fast fetch HTTP ${fast.status}`;
      }
    } catch (err) {
      result.warning = `Fast fetch failed: ${err.message || err}`;
    }
  }

  if ((mode === 'browser' || mode === 'auto') && result.text.length < 200) {
    try {
      const browser = await fetchBrowser(url);
      result = {
        title: browser.title || result.title,
        text: browser.text || '',
        source: 'playwright',
        status: result.status,
        warning: result.warning,
      };
    } catch (err) {
      if (!result.text) {
        return withEnvelope({
          ok: false,
          source: 'playwright',
          confidence: 'none',
          data: { url, title: null, text: '', chars: 0 },
          error: String(err.message || err),
          warning: result.warning,
        });
      }
      result.warning = `${result.warning || ''} | Browser fallback failed: ${err.message || err}`.trim();
    }
  }

  const cut = truncate(result.text, maxChars);
  const payloadOut = {
    url,
    title: result.title,
    text: cut.text,
    chars: cut.text.length,
    truncated: cut.truncated,
    httpStatus: result.status ?? null,
    mode,
  };

  return withEnvelope({
    ok: Boolean(result.text),
    source: result.source,
    confidence: confidenceFromSource(result.source === 'playwright' ? 'scrape' : result.source),
    data: payloadOut,
    warning: result.warning,
    error: result.text ? undefined : 'No page text extracted',
  });
}

function formatResult(result) {
  const env = result?.ok !== undefined ? result : null;
  const data = env?.data || result;
  if (!data?.url) {
    return `Page fetch failed: ${env?.error || result?.error || 'unknown'}`;
  }
  const lines = [
    `URL: ${data.url}`,
    data.title ? `Title: ${data.title}` : null,
    `Source: ${env?.source || data.source || '?'} · chars=${data.chars || 0}${data.truncated ? ' (truncated)' : ''}`,
  ].filter(Boolean);
  if (env?.warning) lines.push(`Warning: ${env.warning}`);
  if (env?.error) lines.push(`Error: ${env.error}`);
  lines.push('', data.text || '(empty)');
  return lines.join('\n');
}

module.exports = webFetchPageTask;
module.exports.formatResult = formatResult;
module.exports.normalizeUrl = normalizeUrl;
module.exports.htmlToText = htmlToText;
