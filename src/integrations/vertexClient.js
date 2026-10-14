/**
 * Google Vertex AI via the global OpenAI-compatible chat endpoint.
 * Model ids in the app are prefixed with "vertex:" so they do not collide with AI Studio ids.
 * Vertex expects the API id as "google/<model>".
 */

const { startTimer } = require('../util/timing');

const PREFIX = 'vertex:';

function accessToken() {
  return String(process.env.GOOGLE_VERTEX_ACCESS_TOKEN || '').trim();
}

/** OAuth access tokens use Bearer. API keys are rejected in that header. */
function authHeaders(credential) {
  if (credential.startsWith('ya29.')) return { authorization: `Bearer ${credential}` };
  return { 'x-goog-api-key': credential };
}

function projectId() {
  return String(process.env.GOOGLE_VERTEX_PROJECT_ID || '').trim();
}

function isConfigured() {
  return Boolean(accessToken() && projectId());
}

function isVertexModel(modelId) {
  return String(modelId || '').startsWith(PREFIX);
}

function endpoint() {
  const project = projectId();
  if (!project) return '';
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/global/endpoints/openapi/chat/completions`;
}

/** Strip the app prefix and add the publisher Vertex requires. */
function toApiModelId(modelId) {
  const id = String(modelId || '');
  const bare = id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id;
  if (!bare) return '';
  return bare.includes('/') ? bare : `google/${bare}`;
}

function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('request was aborted') || msg.includes('this operation was aborted');
}

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
  const key = accessToken();
  const url = endpoint();
  if (!key) throw new Error('GOOGLE_VERTEX_ACCESS_TOKEN is not set');
  if (!url) throw new Error('GOOGLE_VERTEX_PROJECT_ID is not set');
  const apiModel = toApiModelId(model);
  if (!apiModel) throw new Error('Google Vertex requires a model id');

  const body = { model: apiModel, messages, temperature };
  if (responseFormat) body.response_format = responseFormat;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }

  const msgChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const timer = startTimer('vertex.chat.completions');

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(key),
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
      (payload && payload.error && (payload.error.message || payload.error.status)) ||
      text ||
      `Google Vertex request failed (${res.status})`;
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
  isVertexModel,
  toApiModelId,
};
