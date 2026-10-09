/**
 * Picks Groq, Google AI Studio, or OpenRouter for a chat completion.
 * If that model errors, the other models on the same router are tried.
 * The turn records the switch so the reply can tell the user.
 */

const groq = require('./groqClient');
const google = require('./googleAiClient');
const openrouter = require('./openRouterClient');
const catalog = require('./modelCatalog');

function providerLabel(modelId) {
  const id = modelId || groq.activeModel();
  if (String(id || '').startsWith('gemini-')) return 'AI Studio';
  if (openrouter.isOpenRouterModel(id)) return 'OpenRouter';
  return 'Groq';
}

function isConfigured() {
  const id = groq.activeModel();
  if (String(id || '').startsWith('gemini-')) return google.isConfigured();
  if (openrouter.isOpenRouterModel(id)) return openrouter.isConfigured();
  return groq.isConfigured();
}

function dispatch(opts) {
  if (String(opts.model || '').startsWith('gemini-')) return google.chat(opts);
  if (openrouter.isOpenRouterModel(opts.model)) return openrouter.chat(opts);
  return groq.chat(opts);
}

function hasOutput(result) {
  const message = result?.choices?.[0]?.message;
  if (!message) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  return typeof message.content === 'string' && message.content.trim().length > 0;
}

function abortError() {
  const err = new Error('The request was cancelled');
  err.name = 'AbortError';
  return err;
}

function failedIds(turn) {
  return Array.isArray(turn?.failedModels) ? turn.failedModels : [];
}

function rememberFailure(turn, modelId) {
  if (!turn) return;
  const failed = failedIds(turn);
  if (!failed.includes(modelId)) failed.push(modelId);
  turn.failedModels = failed;
}

function rememberSwitch(turn, from, to) {
  if (!turn || from === to) return;
  if (!Array.isArray(turn.switches)) turn.switches = [];
  turn.switches.push({ from, to });
  turn.model = to;
}

/**
 * Same options as groqClient.chat.
 * A Gemini id goes to Google AI Studio. An openrouter: id goes to OpenRouter.
 * @param {{ messages: object[], tools?: object[], toolChoice?: string|object, model?: string, temperature?: number, responseFormat?: object, signal?: AbortSignal }} [opts]
 */
async function chat(opts = {}) {
  const turn = groq.currentTurn();
  const signal = opts.signal || turn?.signal;
  const requested = opts.model || turn?.model;
  if (signal?.aborted) throw abortError();

  const list = catalog.candidates(requested, failedIds(turn));
  if (!list.length) throw new Error('No remaining model to try');

  /** @type {unknown} */
  let lastErr = null;
  const tried = [];

  for (const id of list) {
    if (signal?.aborted) throw abortError();
    tried.push(id);
    try {
      const result = await dispatch({ ...opts, model: id, signal });
      if (!hasOutput(result)) {
        const err = new Error('The model returned an empty response');
        err.status = 502;
        throw err;
      }
      if (id !== requested) rememberSwitch(turn, requested, id);
      return result;
    } catch (err) {
      lastErr = err;
      if (catalog.isAbortError(err) || signal?.aborted) throw err;
      rememberFailure(turn, id);
      const more = catalog.isFallbackError(err) && tried.length < list.length;
      if (!more) {
        if (tried.length > 1) throw catalog.attemptError(tried, err);
        throw err;
      }
      console.warn(
        `[router] ${catalog.modelLabel(id)} failed (${err && err.message ? err.message : err}); trying another model`
      );
    }
  }

  throw lastErr || new Error('The model request failed');
}

function inTurn() {
  return Boolean(groq.currentTurn());
}

function withModelSwitch(reply) {
  const turn = groq.currentTurn();
  return catalog.attachModelSwitch(reply, turn?.switches);
}

function modelSwitchNotice() {
  const turn = groq.currentTurn();
  return catalog.switchNotice(turn?.switches);
}

module.exports = {
  chat,
  isConfigured,
  isAbortError: groq.isAbortError,
  runWithTurn: groq.runWithTurn,
  activeModel: groq.activeModel,
  providerLabel,
  isGoogleModel: (modelId) => String(modelId || '').startsWith('gemini-'),
  withModelSwitch,
  modelSwitchNotice,
  inTurn,
  DEFAULT_MODEL: groq.DEFAULT_MODEL,
};
