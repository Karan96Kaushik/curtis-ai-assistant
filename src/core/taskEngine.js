const jiraUpdateTask = require('../tasks/jiraUpdate');
const jiraMyIssuesTask = require('../tasks/jiraMyIssues');
const jiraWhoamiTask = require('../tasks/jiraWhoami');
const jiraCreateTask = require('../tasks/jiraCreate');

const tasks = {
  'jira-update': jiraUpdateTask,
  'jira-my-issues': jiraMyIssuesTask,
  'jira-whoami': jiraWhoamiTask,
  'jira-create': jiraCreateTask,
};

/**
 * Dispatch a named task with the given payload.
 * @param {string} name
 * @param {object} payload
 * @returns {Promise<*>}
 */
async function run(name, payload = {}) {
  const task = tasks[name];
  if (!task) {
    const known = Object.keys(tasks).join(', ') || '(none)';
    throw new Error(`Unknown task: ${name}. Known tasks: ${known}`);
  }
  return task(payload);
}

function listTasks() {
  return Object.keys(tasks);
}

module.exports = { run, listTasks, tasks };
