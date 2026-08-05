const { createJiraClient, JiraError, browseUrl, adfToPlainText } = require('../integrations/jiraClient');

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/i;

function normalizeIssueKey(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(s)) return null;
  return s;
}

/**
 * Fetch a single Jira issue by exact key via GET /rest/api/3/issue/{key}.
 * Never uses fuzzy text search.
 * @param {{ issue: string, include_comments?: boolean|string|number, max_comments?: number|string }} payload
 */
async function jiraGetIssueTask(payload = {}) {
  const issueKey = normalizeIssueKey(payload.issue || payload.key || payload.issueKey);
  if (!issueKey) {
    throw new Error('Missing or invalid issue key (expected e.g. P25-3488)');
  }

  const includeComments =
    payload.include_comments === true ||
    payload.include_comments === 'true' ||
    payload.include_comments === 1 ||
    payload.includeComments === true;

  let maxComments = Number(payload.max_comments ?? payload.maxComments ?? 5);
  if (!Number.isFinite(maxComments) || maxComments < 0) maxComments = 5;
  maxComments = Math.min(Math.floor(maxComments), 20);

  const jira = createJiraClient();
  console.error(`[jira-get-issue] GET ${jira.baseUrl}/rest/api/3/issue/${issueKey}`);

  let data;
  try {
    data = await jira.getIssue(issueKey, {
      fields: [
        'summary',
        'status',
        'priority',
        'issuetype',
        'assignee',
        'reporter',
        'description',
        'updated',
        'created',
        'resolution',
        'labels',
        'components',
        'project',
      ],
    });
  } catch (err) {
    if (err instanceof JiraError && err.status === 404) {
      return {
        ok: false,
        found: false,
        issueKey,
        browseUrl: browseUrl(jira.baseUrl, issueKey),
        baseUrl: jira.baseUrl,
        error: `Issue not found: ${issueKey}`,
      };
    }
    throw err;
  }

  const f = data.fields || {};
  const key = data.key || issueKey;
  const description = adfToPlainText(f.description).trim() || '(no description)';

  const result = {
    ok: true,
    found: true,
    issueKey: key,
    browseUrl: browseUrl(jira.baseUrl, key),
    baseUrl: jira.baseUrl,
    summary: f.summary || '(no summary)',
    status: f.status?.name || 'Unknown',
    priority: f.priority?.name || null,
    type: f.issuetype?.name || null,
    project: f.project?.key || null,
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    resolution: f.resolution?.name || null,
    labels: Array.isArray(f.labels) ? f.labels : [],
    components: Array.isArray(f.components) ? f.components.map((c) => c.name).filter(Boolean) : [],
    created: f.created || null,
    updated: f.updated || null,
    description,
    comments: [],
  };

  if (includeComments && maxComments > 0) {
    try {
      const { comments } = await jira.getComments(key, { maxResults: maxComments, orderBy: '-created' });
      result.comments = (comments || []).map((c) => ({
        id: c.id,
        author: c.author?.displayName || '?',
        created: c.created,
        body: adfToPlainText(c.body).trim().slice(0, 1500),
      }));
    } catch (err) {
      result.commentsWarning = String(err.message || err);
    }
  }

  return result;
}

function formatResult(result) {
  if (!result?.found) {
    return [
      `Issue not found: ${result?.issueKey || '?'}`,
      result?.browseUrl ? `Expected URL (if it existed): ${result.browseUrl}` : null,
      'This was an exact key lookup (GET /issue/{key}), not a text search.',
      'Do not invent a different ticket or claim the key was never listed.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const lines = [
    `${result.issueKey} — ${result.summary}`,
    `URL: ${result.browseUrl}`,
    `Type: ${result.type || '?'} · Status: ${result.status}${result.priority ? ` · Priority: ${result.priority}` : ''}`,
    `Project: ${result.project || '?'} · Assignee: ${result.assignee || 'Unassigned'} · Reporter: ${result.reporter || '?'}`,
  ];
  if (result.resolution) lines.push(`Resolution: ${result.resolution}`);
  if (result.labels?.length) lines.push(`Labels: ${result.labels.join(', ')}`);
  if (result.components?.length) lines.push(`Components: ${result.components.join(', ')}`);
  if (result.created) lines.push(`Created: ${result.created}`);
  if (result.updated) lines.push(`Updated: ${result.updated}`);
  lines.push('', 'Description:', result.description.slice(0, 3500));

  if (result.comments?.length) {
    lines.push('', `Recent comments (${result.comments.length}):`);
    for (const c of result.comments) {
      lines.push(`- [${c.id}] ${c.author} (${c.created}): ${c.body.slice(0, 400)}`);
    }
  } else if (result.commentsWarning) {
    lines.push('', `Comments unavailable: ${result.commentsWarning}`);
  }

  return lines.join('\n');
}

module.exports = jiraGetIssueTask;
module.exports.formatResult = formatResult;
module.exports.normalizeIssueKey = normalizeIssueKey;
module.exports.ISSUE_KEY_RE = ISSUE_KEY_RE;
