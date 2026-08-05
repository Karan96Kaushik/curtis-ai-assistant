const Groq = require('groq-sdk');
const { startTimer } = require('../util/timing');

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-20b';
const KEY_ENVS = ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3'];

let clients = null;
let rrIndex = 0;

function getApiKeys() {
  return KEY_ENVS.map((name) => process.env[name]).filter(Boolean);
}

function getClients() {
  if (!clients) {
    const keys = getApiKeys();
    if (!keys.length) {
      throw new Error('Missing GROQ_API_KEY (or GROQ_API_KEY_2 or GROQ_API_KEY_3) in .env');
    }
    clients = keys.map((apiKey) => new Groq({ apiKey }));
  }
  return clients;
}

/** Returns the next Groq client via round-robin across configured API keys. */
function createGroqClient() {
  const pool = getClients();
  const client = pool[rrIndex % pool.length];
  rrIndex = (rrIndex + 1) % pool.length;
  return client;
}

function isRateLimited(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === 429) return true;
  const code = String(err?.code || err?.error?.code || '').toLowerCase();
  if (code.includes('rate_limit')) return true;
  const msg = String(err?.message || err?.error?.message || '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests')
  );
}

function uniqueModels(primary) {
  const list = [primary || DEFAULT_MODEL];
  if (FALLBACK_MODEL && !list.includes(FALLBACK_MODEL)) {
    list.push(FALLBACK_MODEL);
  }
  return list;
}

/**
 * Chat completion with optional tools.
 * On HTTP 429: rotate through remaining API keys, then retry with FALLBACK_MODEL.
 * @param {{ messages: object[], tools?: object[], toolChoice?: string|object, model?: string, temperature?: number }} opts
 */
async function chat({ messages, tools, toolChoice, model = DEFAULT_MODEL, temperature = 0.2 }) {
  const pool = getClients();
  const models = uniqueModels(model);

  const bodyBase = {
    messages,
    temperature,
  };
  if (tools?.length) {
    bodyBase.tools = tools;
    bodyBase.tool_choice = toolChoice || 'auto';
  } else if (toolChoice === 'none') {
    bodyBase.tool_choice = 'none';
  }

  const msgChars = messages.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0),
    0
  );
  const timer = startTimer('groq.chat.completions');

  /** @type {Error | null} */
  let lastErr = null;

  for (let mi = 0; mi < models.length; mi++) {
    const activeModel = models[mi];
    if (mi > 0) {
      console.warn(
        `[groq] Switching to fallback model ${activeModel} after rate limits on ${models[0]}`
      );
    }

    for (let i = 0; i < pool.length; i++) {
      const keyIndex = (rrIndex + i) % pool.length;
      const client = pool[keyIndex];
      const keyLabel = KEY_ENVS[keyIndex] || `key#${keyIndex}`;

      try {
        const result = await client.chat.completions.create({
          ...bodyBase,
          model: activeModel,
        });
        // Prefer the next key on subsequent calls (load-spread after success).
        rrIndex = (keyIndex + 1) % pool.length;
        timer.end(
          `model=${activeModel} key=${keyLabel} messages=${messages.length} msgChars≈${msgChars} tools=${tools?.length || 0}`
        );
        return result;
      } catch (err) {
        lastErr = err;
        if (isRateLimited(err)) {
          console.warn(
            `[groq] 429 rate limit on ${keyLabel} model=${activeModel}; trying next key/model`
          );
          continue;
        }
        timer.end(`FAILED model=${activeModel} key=${keyLabel}`);
        throw err;
      }
    }
  }

  timer.end('FAILED all keys/models rate-limited');
  throw lastErr || new Error('Groq rate limited on all API keys and models');
}

function isConfigured() {
  return getApiKeys().length > 0;
}

module.exports = {
  createGroqClient,
  chat,
  isConfigured,
  isRateLimited,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
};
