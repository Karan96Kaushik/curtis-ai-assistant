const { createJiraClient, JiraError, browseUrl } = require('../integrations/jiraClient');
const { parseList } = require('../util/parseList');

/**
 * Create a Jira issue.
 * @param {{
 *   project: string,
 *   summary: string,
 *   type?: string,
 *   description?: string,
 *   assignToMe?: boolean,
 *   parent?: string,
 *   labels?: string|string[],
 *   priority?: string,
 *   components?: string|string[],
 * }} payload
 */
async function jiraCreateTask(payload = {}) {
  const project = payload.project?.trim();
  const summary = payload.summary?.trim();
  const issueType = payload.type?.trim() || 'Task';
  const description = payload.description?.trim() || undefined;
  const parentKey = payload.parent?.trim() || undefined;
  const labels = parseList(payload.labels);
  const components = parseList(payload.components);
  const priority = payload.priority?.trim() || undefined;
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

  let created;
  try {
    created = await jira.createIssue({
      projectKey: project,
      summary,
      issueType,
      description,
      assigneeAccountId,
      parentKey,
      labels,
      priority,
      components,
    });
  } catch (err) {
    if (err instanceof JiraError && err.status === 400 && /issuetype|issue type/i.test(err.message)) {
      const types = await jira.getCreatableIssueTypes(project).catch(() => []);
      const names = types.map((t) => t.name).filter(Boolean);
      if (names.length) {
        throw new Error(`${err.message}. Issue types available in ${project}: ${names.join(', ')}`);
      }
    }
    throw err;
  }

  const issueKey = created.key;
  const url = browseUrl(jira.baseUrl, issueKey);

  return {
    issueKey,
    id: created.id,
    browseUrl: url,
    project,
    summary,
    issueType,
    parentKey: parentKey ? parentKey.toUpperCase() : null,
    labels,
    priority: priority || null,
    components,
    assignedToMe: assignToMe,
  };
}

function formatResult(result) {
  const lines = [
    `Created ${result.issueKey} (${result.issueType}) in ${result.project}`,
    `Summary: ${result.summary}`,
    `URL: ${result.browseUrl}`,
  ];
  if (result.parentKey) lines.push(`Parent: ${result.parentKey}`);
  if (result.priority) lines.push(`Priority: ${result.priority}`);
  if (result.labels?.length) lines.push(`Labels: ${result.labels.join(', ')}`);
  if (result.components?.length) lines.push(`Components: ${result.components.join(', ')}`);
  if (result.assignedToMe) {
    lines.push('Assignee: you');
  }
  return lines.join('\n');
}

module.exports = jiraCreateTask;
module.exports.formatResult = formatResult;
