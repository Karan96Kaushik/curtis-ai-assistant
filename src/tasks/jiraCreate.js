const { createJiraClient, browseUrl } = require('../integrations/jiraClient');

/**
 * Create a Jira issue.
 * @param {{
 *   project: string,
 *   summary: string,
 *   type?: string,
 *   description?: string,
 *   assignToMe?: boolean,
 * }} payload
 */
async function jiraCreateTask(payload = {}) {
  const project = payload.project?.trim();
  const summary = payload.summary?.trim();
  const issueType = payload.type?.trim() || 'Task';
  const description = payload.description?.trim() || undefined;
  // Default: assign to auth user unless explicitly false
  const assignToMe =
    payload.assignToMe === undefined || payload.assignToMe === null
      ? true
      : Boolean(payload.assignToMe);

  if (!project) throw new Error('Missing required field: project');
  if (!summary) throw new Error('Missing required field: summary');

  const jira = createJiraClient();
  let assigneeAccountId;
  if (assignToMe) {
    const myself = await jira.getMyself();
    assigneeAccountId = myself.accountId;
  }

  const created = await jira.createIssue({
    projectKey: project,
    summary,
    issueType,
    description,
    assigneeAccountId,
  });

  const issueKey = created.key;
  const url = browseUrl(jira.baseUrl, issueKey);

  return {
    issueKey,
    id: created.id,
    browseUrl: url,
    project,
    summary,
    issueType,
    assignedToMe: assignToMe,
  };
}

function formatResult(result) {
  const lines = [
    `Created ${result.issueKey} (${result.issueType}) in ${result.project}`,
    `Summary: ${result.summary}`,
    `URL: ${result.browseUrl}`,
  ];
  if (result.assignedToMe) {
    lines.push('Assignee: you');
  }
  return lines.join('\n');
}

module.exports = jiraCreateTask;
module.exports.formatResult = formatResult;
