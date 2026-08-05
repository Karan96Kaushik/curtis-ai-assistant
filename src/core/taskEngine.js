const registry = require('./moduleRegistry');

let modulesLoaded = false;
function ensureModules() {
  if (modulesLoaded) return;
  modulesLoaded = true;
  require('../modules/index');
}

/**
 * Dispatch a named task with the given payload.
 * @param {string} name
 * @param {object} payload
 * @returns {Promise<*>}
 */
async function run(name, payload = {}) {
  ensureModules();
  const task = registry.getTask(name);
  if (!task) {
    const known = registry.getTasks().join(', ') || '(none)';
    throw new Error(`Unknown task: ${name}. Known tasks: ${known}`);
  }
  return task(payload);
}

function listTasks() {
  ensureModules();
  return registry.getTasks();
}

module.exports = { run, listTasks };
