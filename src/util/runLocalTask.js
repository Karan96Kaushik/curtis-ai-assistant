const { envelopeFromRaw } = require('./taskResult');
const { startTimer } = require('./timing');

/**
 * Run a task in-process and shape it as a tool payload. Modules use this
 * instead of taskRunner to avoid a circular require through the registry.
 * @param {string} name task name (for timing + envelope source)
 * @param {(payload: object) => Promise<unknown>} execute
 * @param {((raw: any) => string) | undefined} format
 * @param {object} [payload]
 * @returns {Promise<{ text: string, envelope: object, raw: unknown }>}
 */
async function runLocalTask(name, execute, format, payload = {}) {
  const timer = startTimer(`task.${name}`);
  try {
    const raw = await execute(payload);
    const text =
      typeof format === 'function'
        ? format(raw)
        : typeof raw === 'object'
          ? JSON.stringify(raw, null, 2)
          : String(raw);
    const envelope = envelopeFromRaw(name, raw);
    timer.end();
    return { text, envelope, raw };
  } catch (err) {
    timer.end('FAILED');
    throw err;
  }
}

module.exports = { runLocalTask };
