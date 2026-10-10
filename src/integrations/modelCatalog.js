/**
 * Fallback order for a router. The user's model is always tried first;
 * the rest of that router's fallback list follows. Extra models are selectable
 * and labeled here, but left out of the automatic chain. Keep labels aligned
 * with lib/chat/models.ts.
 */

const MARKER = '\n\n%%model-switch%%\n';

const GROQ = [
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', router: 'Groq' },
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8 27B', router: 'Groq' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', router: 'Groq' },
];

/** Still on Groq, but enterprise-only. Selectable; not used as automatic fallbacks. */
const GROQ_EXTRA = [
  { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', router: 'Groq' },
  { id: 'minimaxai/minimax-m2.7', label: 'MiniMax M2.7', router: 'Groq' },
  { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B', router: 'Groq' },
];

const GOOGLE = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', router: 'AI Studio' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', router: 'AI Studio' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', router: 'AI Studio' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', router: 'AI Studio' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', router: 'AI Studio' },
];

const OPENROUTER = [
  { id: 'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free', label: 'Nemotron 3 Ultra', router: 'OpenRouter' },
  { id: 'openrouter:thinkingmachines/inkling:free', label: 'Inkling', router: 'OpenRouter' },
  { id: 'openrouter:nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super', router: 'OpenRouter' },
  { id: 'openrouter:nvidia/nemotron-3.5-lightning:free', label: 'Nemotron 3.5 Lightning', router: 'OpenRouter' },
];

/** Free specialists. Selectable; omitted from fallback so one error does not spend the daily free quota. */
const OPENROUTER_EXTRA = [
  { id: 'openrouter:thinkingmachines/inkling-small:free', label: 'Inkling Small', router: 'OpenRouter' },
  { id: 'openrouter:google/gemma-4-31b-it:free', label: 'Gemma 4 31B', router: 'OpenRouter' },
  { id: 'openrouter:qwen/qwen3.8-27b:free', label: 'Qwen 3.8 27B', router: 'OpenRouter' },
  { id: 'openrouter:google/gemma-4-26b-a4b-it:free', label: 'Gemma 4 26B', router: 'OpenRouter' },
];

const ALL = [...GROQ, ...GROQ_EXTRA, ...GOOGLE, ...OPENROUTER, ...OPENROUTER_EXTRA];

function isGoogleModel(modelId) {
  return String(modelId || '').startsWith('gemini-');
}

function isOpenRouterModel(modelId) {
  return String(modelId || '').startsWith('openrouter:');
}

function chainFor(modelId) {
  if (isGoogleModel(modelId)) return GOOGLE;
  if (isOpenRouterModel(modelId)) return OPENROUTER;
  return GROQ;
}

function modelLabel(modelId) {
  const row = ALL.find((model) => model.id === modelId);
  if (!row) return String(modelId || 'the selected model');
  return `${row.label} (${row.router})`;
}

/**
 * Selected model, then the other models on the same router.
 * @param {string} modelId
 * @param {string[] | null | undefined} failedIds
 */
function candidates(modelId, failedIds) {
  const failed = new Set(failedIds || []);
  const chain = chainFor(modelId).map((model) => model.id);
  if (!isGoogleModel(modelId) && !isOpenRouterModel(modelId)) {
    const extra = String(process.env.GROQ_FALLBACK_MODEL || '').trim();
    if (extra && !chain.includes(extra)) chain.push(extra);
  }
  const ordered = [];
  if (modelId && !failed.has(modelId)) ordered.push(modelId);
  for (const id of chain) {
    if (!failed.has(id) && !ordered.includes(id)) ordered.push(id);
  }
  return ordered;
}

function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  if (name === 'AbortError' || name === 'APIUserAbortError') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('request was aborted') || msg.includes('this operation was aborted');
}

/** Errors worth trying on another model. A missing key or a cancelled request is not. */
function isFallbackError(err) {
  if (!err || isAbortError(err)) return false;
  const msg = String(err.message || err.error?.message || '').toLowerCase();
  if (msg.includes('is not set') || msg.includes('missing groq_api_key')) return false;
  const status = Number(err.status ?? err.statusCode ?? err.response?.status);
  if (status === 401 || status === 403) return false;
  if (status === 400) return /credit|max_tokens|too many tokens|context length|maximum context|overloaded|unavailable/.test(msg);
  if (Number.isFinite(status) && status >= 400) return true;
  return true;
}

function switchNotice(switches) {
  if (!Array.isArray(switches) || switches.length === 0) return null;
  const from = modelLabel(switches[0].from);
  const to = modelLabel(switches[switches.length - 1].to);
  if (from === to) return null;
  if (switches.length === 1) return `Switched to ${to} because ${from} returned an error.`;
  return `Switched from ${from} to ${to} after earlier models returned errors.`;
}

function attachModelSwitch(reply, switches) {
  const notice = switchNotice(switches);
  if (!notice) return String(reply ?? '');
  return `${reply}${MARKER}${notice}`;
}

function splitModelSwitch(content) {
  const text = String(content ?? '');
  const at = text.lastIndexOf(MARKER);
  if (at < 0) return { body: text, notice: null };
  const notice = text.slice(at + MARKER.length).trim();
  return { body: text.slice(0, at), notice: notice || null };
}

/** Marker removed so Discord shows the sentence as normal text. */
function displayModelSwitch(content) {
  const { body, notice } = splitModelSwitch(content);
  if (!notice) return body;
  return `${body}\n\n${notice}`;
}

function attemptError(triedIds, err) {
  const names = triedIds.map((id) => modelLabel(id)).join(', ');
  const reason = err && err.message ? err.message : String(err);
  const wrapped = new Error(`${names} failed. ${reason}`);
  if (err && err.status) wrapped.status = err.status;
  return wrapped;
}

module.exports = {
  MARKER,
  candidates,
  modelLabel,
  isFallbackError,
  isAbortError,
  switchNotice,
  attachModelSwitch,
  splitModelSwitch,
  displayModelSwitch,
  attemptError,
};
