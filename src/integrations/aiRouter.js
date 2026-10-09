/**
 * Picks Groq or Google AI Studio for a chat completion.
 * The selected model id decides the router; both can be used in the same app.
 */

const groq = require('./groqClient');
const google = require('./googleAiClient');

function isGoogleModel(modelId) {
  return String(modelId || '').startsWith('gemini-');
}

function providerLabel(modelId) {
  return isGoogleModel(modelId || groq.activeModel()) ? 'AI Studio' : 'Groq';
}

function isConfigured() {
  if (isGoogleModel(groq.activeModel())) return google.isConfigured();
  return groq.isConfigured();
}

/**
 * Same options as groqClient.chat. A Gemini id goes to Google AI Studio.
 * @param {{ messages: object[], tools?: object[], toolChoice?: string|object, model?: string, temperature?: number, responseFormat?: object, signal?: AbortSignal }} [opts]
 */
async function chat(opts = {}) {
  const turn = groq.currentTurn();
  const model = opts.model || turn?.model;
  const signal = opts.signal || turn?.signal;
  const next = { ...opts, model, signal };
  if (isGoogleModel(model)) return google.chat(next);
  return groq.chat(next);
}

module.exports = {
  chat,
  isConfigured,
  isAbortError: groq.isAbortError,
  runWithTurn: groq.runWithTurn,
  activeModel: groq.activeModel,
  providerLabel,
  isGoogleModel,
  DEFAULT_MODEL: groq.DEFAULT_MODEL,
};
