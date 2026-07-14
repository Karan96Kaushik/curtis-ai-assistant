const { createJiraClient } = require('../integrations/jiraClient');

const DEFAULT_MAX = 25;
const HARD_MAX = 50;

function log(...args) {
  console.error('[jira-my-issues]', ...args);
}

/**
 * List unresolved Jira issues assigned to the authenticated user.
 * @param {{ max?: number|string, status?: string, verbose?: boolean }} payload
 */
async function jiraMyIssuesTask(payload = {}) {
  let max = Number(payload.max);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX;
  max = Math.min(Math.floor(max), HARD_MAX);

  const statusFilter = payload.status?.trim();
  let jql =
    'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
  if (statusFilter) {
    const escaped = statusFilter.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    jql = `assignee = currentUser() AND resolution = Unresolved AND status = "${escaped}" ORDER BY updated DESC`;
  }

  const jira = createJiraClient();

  log(`baseUrl=${jira.baseUrl}`);
  log(`authEmail=${jira.email}`);

  const myself = await jira.getMyself();
  const profile = {
    accountId: myself.accountId || null,
    displayName: myself.displayName || null,
    emailAddress: myself.emailAddress || null,
    active: myself.active,
    timeZone: myself.timeZone || null,
  };
  log(
    `connected as displayName="${profile.displayName}" email="${profile.emailAddress}" accountId=${profile.accountId} active=${profile.active}`
  );
  log(`jql=${jql}`);
  log(`maxResults=${max}`);

  const search = await jira.searchIssues({ jql, maxResults: max });
  log(`search returned issues=${search.issues.length} isLast=${search.isLast}`);

  const items = search.issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary || '(no summary)',
    status: issue.fields?.status?.name || 'Unknown',
    priority: issue.fields?.priority?.name || null,
    type: issue.fields?.issuetype?.name || null,
    assignee: issue.fields?.assignee?.displayName || null,
  }));

  return {
    count: items.length,
    max,
    statusFilter: statusFilter || null,
    jql,
    connection: {
      baseUrl: jira.baseUrl,
      authEmail: jira.email,
      profile,
    },
    issues: items,
  };
}

function formatResult(result) {
  const p = result.connection?.profile || {};
  const connLines = [
    `Jira: ${result.connection?.baseUrl || '?'}`,
    `Auth email (.env): ${result.connection?.authEmail || '?'}`,
    `Connected as: ${p.displayName || '?'} <${p.emailAddress || 'no-email'}> (${p.accountId || 'no-accountId'})`,
    `JQL: ${result.jql}`,
  ];

  const filterNote = result.statusFilter ? ` (status: ${result.statusFilter})` : '';
  if (!result.issues.length) {
    return [
      ...connLines,
      '',
      `No unresolved issues assigned to this account${filterNote}.`,
      'If you expected tickets: confirm the auth email matches your Jira user, and that issues are assigned to that user.',
    ].join('\n');
  }

  const header = `Assigned to you${filterNote}: ${result.count} issue(s)`;
  const lines = result.issues.map((issue) => {
    const pri = issue.priority ? ` · ${issue.priority}` : '';
    return `• ${issue.key} — ${issue.summary} [${issue.status}${pri}]`;
  });
  return [...connLines, '', header, ...lines].join('\n');
}

module.exports = jiraMyIssuesTask;
module.exports.formatResult = formatResult;
