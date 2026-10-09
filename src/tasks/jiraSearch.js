const { createJiraClient, browseUrl } = require('../integrations/jiraClient');

const DEFAULT_MAX = 25;
const HARD_MAX = 50;
const FIELDS = ['summary', 'status', 'priority', 'issuetype', 'assignee', 'reporter', 'updated', 'project'];

/**
 * Search any issues with JQL (not limited to the auth user's assignments).
 * @param {{ jql: string, max?: number|string, next_page_token?: string }} payload
 */
async function jiraSearchTask(payload = {}) {
  const jql = String(payload.jql || '').trim();
  if (!jql) throw new Error('Missing required field: jql');

  let max = Number(payload.max);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX;
  max = Math.min(Math.floor(max), HARD_MAX);

  const jira = createJiraClient();
  const search = await jira.searchIssues({
    jql,
    maxResults: max,
    fields: FIELDS,
    nextPageToken: payload.next_page_token || undefined,
  });

  const issues = search.issues.map((issue) => {
    const f = issue.fields || {};
    return {
      key: issue.key,
      summary: f.summary || '(no summary)',
      status: f.status?.name || 'Unknown',
      priority: f.priority?.name || null,
      type: f.issuetype?.name || null,
      assignee: f.assignee?.displayName || null,
      reporter: f.reporter?.displayName || null,
      updated: f.updated || null,
      browseUrl: browseUrl(jira.baseUrl, issue.key),
    };
  });

  return {
    ok: true,
    source: 'jira',
    confidence: 'high',
    data: {
      jql,
      count: issues.length,
      issues,
      hasMore: search.isLast === false,
      nextPageToken: search.isLast === false ? search.nextPageToken || null : null,
    },
  };
}

function formatResult(raw) {
  const d = raw.data;
  const lines = [`JQL: ${d.jql}`, `${d.count} issue(s)${d.hasMore ? ' (more available — pass next_page_token)' : ''}`];
  if (!d.count) {
    lines.push('No issues matched.');
    return lines.join('\n');
  }
  for (const i of d.issues) {
    const meta = [i.type, i.status, i.priority, i.assignee ? `@${i.assignee}` : 'Unassigned']
      .filter(Boolean)
      .join(' · ');
    lines.push(`• ${i.key} — ${i.summary} [${meta}] ${i.browseUrl}`);
  }
  if (d.nextPageToken) lines.push(`next_page_token: ${d.nextPageToken}`);
  return lines.join('\n');
}

module.exports = jiraSearchTask;
module.exports.formatResult = formatResult;
