const { AsyncLocalStorage } = require('node:async_hooks');
const Groq = require('groq-sdk');
const { startTimer } = require('../util/timing');

const DEFAULT_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || 'openai/gpt-oss-20b';

/** Per-turn model and cancel signal, visible to every chat() in the async call tree. */
const turnStore = new AsyncLocalStorage();
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

function currentTurn() {
  return turnStore.getStore() || null;
}

function activeModel() {
  return currentTurn()?.model || DEFAULT_MODEL;
}

/**
 * Run `fn` so every Groq call inside it uses this model and abort signal.
 * @param {{ model?: string, signal?: AbortSignal }} ctx
 * @param {() => Promise<unknown>} fn
 */
function runWithTurn(ctx, fn) {
  return turnStore.run(ctx || {}, fn);
}

function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  const msg = String(err.message || err.error?.message || '').toLowerCase();
  return msg.includes('request was aborted') || msg.includes('this operation was aborted');
}

/**
 * Chat completion with optional tools.
 * On HTTP 429: rotate through remaining API keys. Another model is chosen by the router.
 * @param {{ messages: object[], tools?: object[], toolChoice?: string|object, model?: string, temperature?: number, responseFormat?: object, signal?: AbortSignal }} opts
 */
async function chat({ messages, tools, toolChoice, model, temperature = 0.2, responseFormat, signal }) {
  const turn = currentTurn();
  const chosen = model || turn?.model || DEFAULT_MODEL;
  const abortSignal = signal || turn?.signal;
  if (abortSignal?.aborted) {
    const err = new Error('The request was cancelled');
    err.name = 'AbortError';
    throw err;
  }
  const pool = getClients();
  const modelId = chosen;

  const bodyBase = {
    messages,
    temperature,
  };
  if (responseFormat) bodyBase.response_format = responseFormat;
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

  for (let i = 0; i < pool.length; i++) {
    const keyIndex = (rrIndex + i) % pool.length;
    const client = pool[keyIndex];
    const keyLabel = KEY_ENVS[keyIndex] || `key#${keyIndex}`;

    try {
      const result = await client.chat.completions.create(
        {
          ...bodyBase,
          model: modelId,
        },
        abortSignal ? { signal: abortSignal } : undefined
      );
      // Prefer the next key on subsequent calls (load-spread after success).
      rrIndex = (keyIndex + 1) % pool.length;
      timer.end(
        `model=${modelId} key=${keyLabel} messages=${messages.length} msgChars≈${msgChars} tools=${tools?.length || 0}`
      );
      return result;
    } catch (err) {
      lastErr = err;
      if (isAbortError(err) || abortSignal?.aborted) {
        timer.end(`aborted model=${modelId}`);
        throw err;
      }
      if (isRateLimited(err)) {
        console.warn(`[groq] 429 rate limit on ${keyLabel} model=${modelId}; trying next key`);
        continue;
      }
      timer.end(`FAILED model=${modelId} key=${keyLabel}`);
      throw err;
    }
  }

  timer.end('FAILED all keys rate-limited');
  throw lastErr || new Error('Groq rate limited on all API keys');
}

function isConfigured() {
  return getApiKeys().length > 0;
}

module.exports = {
  createGroqClient,
  chat,
  isConfigured,
  isRateLimited,
  isAbortError,
  runWithTurn,
  currentTurn,
  activeModel,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
};
