/**
 * OpenRouter via its OpenAI-compatible chat endpoint.
 * Model ids in the app are prefixed with "openrouter:" so they do not collide with Groq ids.
 */

const { startTimer } = require('../util/timing');

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const PREFIX = 'openrouter:';

function apiKey() {
  return String(process.env.OPENROUTER_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(apiKey());
}

function isOpenRouterModel(modelId) {
  return String(modelId || '').startsWith(PREFIX);
}

/** Strip the app prefix. OpenRouter expects ids like "anthropic/claude-opus-5.5". */
function toApiModelId(modelId) {
  const id = String(modelId || '');
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id;
}

function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('request was aborted') || msg.includes('this operation was aborted');
}

/** Some providers return function arguments as an object. The agent parses a string. */
function normalizeToolCalls(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return payload;
  for (const call of calls) {
    const args = call?.function?.arguments;
    if (args != null && typeof args !== 'string') {
      call.function.arguments = JSON.stringify(args);
    }
  }
  return payload;
}

/**
 * @param {{ messages: object[], tools?: object[], toolChoice?: string|object, model?: string, temperature?: number, responseFormat?: object, signal?: AbortSignal }} opts
 */
async function chat({ messages, tools, toolChoice, model, temperature = 0.2, responseFormat, signal }) {
  if (signal?.aborted) {
    const err = new Error('The request was cancelled');
    err.name = 'AbortError';
    throw err;
  }
  const key = apiKey();
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  const apiModel = toApiModelId(model);
  if (!apiModel) throw new Error('OpenRouter requires a model id');

  const body = { model: apiModel, messages, temperature };
  if (responseFormat) body.response_format = responseFormat;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }

  const msgChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const timer = startTimer('openrouter.chat.completions');

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-title': 'Curtis',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      timer.end(`aborted model=${apiModel}`);
      throw err;
    }
    timer.end(`FAILED model=${apiModel}`);
    throw err;
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const message =
      (payload && payload.error && (payload.error.message || payload.error.code)) ||
      text ||
      `OpenRouter request failed (${res.status})`;
    const err = new Error(String(message));
    err.status = res.status;
    timer.end(`FAILED model=${apiModel} status=${res.status}`);
    throw err;
  }

  timer.end(`model=${apiModel} messages=${messages.length} msgChars≈${msgChars} tools=${tools?.length || 0}`);
  return normalizeToolCalls(payload);
}

module.exports = {
  chat,
  isConfigured,
  isAbortError,
  isOpenRouterModel,
  toApiModelId,
};
