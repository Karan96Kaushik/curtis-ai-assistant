const { run } = require('../core/taskEngine');
const registry = require('../core/moduleRegistry');
const { envelopeFromRaw } = require('../util/taskResult');
const { startTimer } = require('../util/timing');

/**
 * Run a task and return formatted text + structured envelope (for the agent ledger).
 * @param {string} name
 * @param {object} payload
 * @returns {Promise<{ text: string, envelope: object, raw: object }>}
 */
async function executeTaskDetailed(name, payload = {}) {
  const timer = startTimer(`task.${name}`);
  try {
    const raw = await run(name, payload);
    const formatter = registry.getTaskFormatter(name);
    
    let text;
    if (formatter) {
      text = formatter(raw);
    } else {
      text = typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw);
    }

    const envelope = envelopeFromRaw(name, raw);
    timer.end();
    return { text, envelope, raw };
  } catch (err) {
    timer.end('FAILED');
    throw err;
  }
}

/**
 * Backward-compatible string result for Discord slash/prefix commands.
 * @param {string} name
 * @param {object} payload
 * @returns {Promise<string>}
 */
async function executeTask(name, payload = {}) {
  const { text } = await executeTaskDetailed(name, payload);
  return text;
}

module.exports = { executeTask, executeTaskDetailed };
