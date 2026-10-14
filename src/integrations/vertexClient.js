/**
 * Google Vertex AI via the global OpenAI-compatible chat endpoint.
 * Model ids in the app are prefixed with "vertex:" so they do not collide with AI Studio ids.
 * Vertex expects the API id as "google/<model>".
 */

const crypto = require('crypto');
const { startTimer } = require('../util/timing');

const PREFIX = 'vertex:';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** @type {{ token: string, exp: number, email: string }} */
let cachedAccessToken = { token: '', exp: 0, email: '' };

function accessToken() {
  return String(process.env.GOOGLE_VERTEX_ACCESS_TOKEN || '').trim();
}

function serviceAccountRaw() {
  return String(process.env.GOOGLE_VERTEX_SERVICE_ACCOUNT || '').trim();
}

function credentialValue(raw) {
  return String(raw || '').trim().replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '');
}

/** OAuth access tokens use Bearer. API keys are rejected in that header. */
function authHeaders(credential) {
  if (credential.startsWith('ya29.')) return { authorization: `Bearer ${credential}` };
  return { 'x-goog-api-key': credential };
}

function googleError(payload) {
  const body = Array.isArray(payload) ? payload[0] : payload;
  const error = body && typeof body === 'object' ? body.error : null;
  if (!error || typeof error !== 'object') return null;
  const reason = Array.isArray(error.details) ? error.details.find((item) => item && item.reason)?.reason : '';
  return { message: String(error.message || error.status || ''), reason: String(reason || '') };
}

function projectId() {
  return String(process.env.GOOGLE_VERTEX_PROJECT_ID || '').trim();
}

function parseServiceAccount(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.type !== 'service_account' || !parsed.private_key || !parsed.client_email) return null;
    return parsed;
  } catch {
    return null;
  }
}

function signServiceAccountJwt(account) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: account.client_email,
      scope: CLOUD_SCOPE,
      aud: account.token_uri || TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  ).toString('base64url');
  const data = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  signer.end();
  return `${data}.${signer.sign(account.private_key).toString('base64url')}`;
}

async function serviceAccountAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken.token && cachedAccessToken.email === account.client_email && cachedAccessToken.exp > now + 60) {
    return cachedAccessToken.token;
  }
  const assertion = signServiceAccountJwt(account);
  const res = await fetch(account.token_uri || TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!res.ok || !payload?.access_token) {
    const message = payload?.error_description || payload?.error || text || `token exchange failed (${res.status})`;
    const err = new Error(`Google Vertex service account token exchange failed: ${message}`);
    err.status = res.status;
    throw err;
  }
  cachedAccessToken = {
    token: payload.access_token,
    exp: now + Number(payload.expires_in || 3600),
    email: account.client_email,
  };
  return cachedAccessToken.token;
}

/**
 * Prefer the service-account secret. It mints a short-lived ya29 token.
 * A raw access token or API key in GOOGLE_VERTEX_ACCESS_TOKEN still works.
 * @returns {Promise<{ projectId: string, headers: Record<string, string> }>}
 */
async function resolveVertexRequest() {
  const account = parseServiceAccount(serviceAccountRaw());
  const project = projectId() || String(account?.project_id || '').trim();
  if (account) {
    const token = await serviceAccountAccessToken(account);
    return { projectId: project, headers: { authorization: `Bearer ${token}` } };
  }
  const key = credentialValue(accessToken());
  if (!key || !project) {
    const err = new Error('GOOGLE_VERTEX_SERVICE_ACCOUNT or GOOGLE_VERTEX_ACCESS_TOKEN is not set');
    err.status = 0;
    throw err;
  }
  return { projectId: project, headers: authHeaders(key) };
}

function isConfigured() {
  if (parseServiceAccount(serviceAccountRaw())) return true;
  return Boolean(accessToken() && projectId());
}

function isVertexModel(modelId) {
  return String(modelId || '').startsWith(PREFIX);
}

function endpointFor(project) {
  const id = String(project || '').trim();
  if (!id) return '';
  return `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(id)}/locations/global/endpoints/openapi/chat/completions`;
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
  const auth = await resolveVertexRequest();
  const url = endpointFor(auth.projectId);
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
        ...auth.headers,
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
    const parsed = googleError(payload);
    let message = parsed?.message || text || `Google Vertex request failed (${res.status})`;
    if (parsed?.reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED') {
      message =
        'Google Vertex rejected GOOGLE_VERTEX_ACCESS_TOKEN. That value is an OAuth access token (ya29) Vertex will not accept. Put the API key in that secret instead.';
    }
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
  resolveVertexRequest,
};
