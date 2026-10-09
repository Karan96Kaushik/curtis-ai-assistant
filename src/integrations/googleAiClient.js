/**
 * Google AI Studio via the Gemini OpenAI-compatible chat endpoint.
 * Tool calls stay in the same shape the agent already expects from Groq.
 */

const { startTimer } = require('../util/timing');

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

function apiKey() {
  return String(process.env.GOOGLE_AI_STUDIO_API_KEY || '').trim();
}

function isConfigured() {
  return Boolean(apiKey());
}

function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('request was aborted') || msg.includes('this operation was aborted');
}

/** Gemini sometimes returns function arguments as an object. The agent parses a string. */
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
  if (!key) throw new Error('GOOGLE_AI_STUDIO_API_KEY is not set');
  if (!model) throw new Error('Google AI Studio requires a model id');

  const body = { model, messages, temperature };
  if (responseFormat) body.response_format = responseFormat;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }

  const msgChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const timer = startTimer('google.chat.completions');

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (isAbortError(err) || signal?.aborted) {
      timer.end(`aborted model=${model}`);
      throw err;
    }
    timer.end(`FAILED model=${model}`);
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
      (payload && payload.error && (payload.error.message || payload.error.status)) ||
      text ||
      `Google AI Studio request failed (${res.status})`;
    const err = new Error(String(message));
    err.status = res.status;
    timer.end(`FAILED model=${model} status=${res.status}`);
    throw err;
  }

  timer.end(`model=${model} messages=${messages.length} msgChars≈${msgChars} tools=${tools?.length || 0}`);
  return normalizeToolCalls(payload);
}

module.exports = {
  chat,
  isConfigured,
  isAbortError,
};
