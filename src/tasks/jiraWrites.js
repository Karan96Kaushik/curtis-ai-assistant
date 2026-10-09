/**
 * Jira writes beyond create/update: issue links and worklogs.
 */

const { createJiraClient, JiraError, browseUrl } = require('../integrations/jiraClient');
const { normalizeIssueKey } = require('../util/jiraKeys');

/**
 * Link two issues. Direction follows Jira's outward wording for the type:
 * "P25-1 blocks P25-2" → { from: P25-1, to: P25-2, type: 'Blocks' }.
 * @param {{ from: string, to: string, type?: string }} payload
 */
async function linkIssues(payload = {}) {
  const from = normalizeIssueKey(payload.from);
  const to = normalizeIssueKey(payload.to);
  if (!from || !to) throw new Error('Provide from and to as issue keys (e.g. P25-1, P25-2)');
  const type = String(payload.type || 'Relates').trim();
  const jira = createJiraClient();
  try {
    // Jira REST shows the outward phrase ("blocks") on inwardIssue, so "from" goes there.
    await jira.createIssueLink({ inwardKey: from, outwardKey: to, type });
  } catch (err) {
    if (err instanceof JiraError && (err.status === 404 || err.status === 400)) {
      throw new Error(`Could not link ${from} → ${to} as "${type}": ${err.message}`);
    }
    throw err;
  }
  return {
    ok: true,
    source: 'jira',
    confidence: 'high',
    data: { from, to, type, browseUrl: browseUrl(jira.baseUrl, from) },
  };
}

function formatLinkIssues(raw) {
  const d = raw.data;
  return `Linked ${d.from} → ${d.to} (${d.type}). URL: ${d.browseUrl}`;
}

/**
 * Log time against an issue.
 * @param {{ issue: string, time_spent: string, started?: string, comment?: string }} payload
 */
async function logWork(payload = {}) {
  const issueKey = normalizeIssueKey(payload.issue);
  if (!issueKey) throw new Error('Missing or invalid issue key');
  const timeSpent = String(payload.time_spent || '').trim();
  if (!/^(\d+(\.\d+)?\s*[wdhm]\s*)+$/i.test(timeSpent)) {
    throw new Error('time_spent must use Jira duration syntax, e.g. "1h 30m", "2h", "1d"');
  }
  const jira = createJiraClient();
  const created = await jira.addWorklog(issueKey, {
    timeSpent,
    started: payload.started || undefined,
    comment: payload.comment || undefined,
  });
  return {
    ok: true,
    source: 'jira',
    confidence: 'high',
    data: {
      issueKey,
      worklogId: created?.id || null,
      timeSpent,
      started: created?.started || payload.started || null,
      browseUrl: browseUrl(jira.baseUrl, issueKey),
    },
  };
}

function formatLogWork(raw) {
  const d = raw.data;
  return `Logged ${d.timeSpent} on ${d.issueKey}${d.started ? ` (started ${d.started})` : ''}. URL: ${d.browseUrl}`;
}

module.exports = { linkIssues, formatLinkIssues, logWork, formatLogWork };
