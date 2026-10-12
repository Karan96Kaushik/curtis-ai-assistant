function cloneForDebug(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * When turn.debugContext is true, append a copy of the provider request to turn.modelDebug.
 * @param {{ debugContext?: boolean, modelDebug?: object[] } | null | undefined} turn
 * @param {string} modelId
 * @param {{ messages?: object[], tools?: object[], toolChoice?: string | object }} opts
 */
function appendModelDebug(turn, modelId, opts) {
  if (!turn?.debugContext) return;
  if (!Array.isArray(turn.modelDebug)) turn.modelDebug = [];
  turn.modelDebug.push({
    model: modelId,
    messages: cloneForDebug(opts.messages || []),
    tools: opts.tools?.length ? cloneForDebug(opts.tools) : undefined,
    toolChoice: opts.toolChoice,
  });
}

module.exports = {
  appendModelDebug,
  cloneForDebug,
};
