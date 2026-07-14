const { run } = require('../core/taskEngine');
const { formatResult: formatUpdate } = require('../tasks/jiraUpdate');
const { formatResult: formatMyIssues } = require('../tasks/jiraMyIssues');
const { formatResult: formatCreate } = require('../tasks/jiraCreate');
const { formatResult: formatWhoami } = require('../tasks/jiraWhoami');

async function executeTask(name, payload = {}) {
  if (name === 'jira-update') {
    return formatUpdate(await run('jira-update', payload));
  }
  if (name === 'jira-my-issues') {
    return formatMyIssues(await run('jira-my-issues', payload));
  }
  if (name === 'jira-create') {
    return formatCreate(
      await run('jira-create', {
        ...payload,
        assignToMe: Boolean(payload.assignToMe || payload.assign_me),
      })
    );
  }
  if (name === 'jira-whoami') {
    return formatWhoami(await run('jira-whoami'));
  }
  throw new Error(`Unknown task: ${name}`);
}

module.exports = { executeTask };
