/**
 * GitHub issues (not PRs): search, read one, and the gated writes
 * (comment on an issue/PR, create an issue).
 */

const { createGithubClient, GithubError, repoFromPayload, parseRepo } = require('../integrations/githubClient');
const { parseList } = require('../util/parseList');

function envelope(data) {
  return { ok: true, source: 'github', confidence: 'high', data };
}

function repoFromUrl(apiUrl) {
  return apiUrl ? String(apiUrl).replace(/^https:\/\/api\.github\.com\/repos\//, '') : null;
}

/** @param {{ query?: string, repo?: string, state?: string, max?: number }} payload */
async function searchIssues(payload = {}) {
  let max = Number(payload.max);
  if (!Number.isFinite(max) || max <= 0) max = 10;
  max = Math.min(Math.floor(max), 50);

  let query = String(payload.query || '').trim();
  if (payload.repo) {
    const { owner, repo } = parseRepo(payload.repo);
    if (!/\brepo:/i.test(query)) query = `repo:${owner}/${repo} ${query}`.trim();
  }
  if (!query) throw new Error('Missing issue search query (or repo)');
  if (!/\b(type|is):(issue|pr)\b/i.test(query)) query = `${query} is:issue`;
  const state = String(payload.state || '').toLowerCase();
  if ((state === 'open' || state === 'closed') && !/\bis:(open|closed)\b/i.test(query)) {
    query = `${query} is:${state}`;
  }

  const github = createGithubClient();
  const data = await github.searchIssues({ q: query, per_page: max, sort: 'updated', order: 'desc' });
  const issues = (data.items || []).map((i) => ({
    repo: repoFromUrl(i.repository_url),
    number: i.number,
    title: i.title,
    state: i.state,
    user: i.user?.login || null,
    assignees: (i.assignees || []).map((a) => a.login),
    labels: (i.labels || []).map((l) => l.name).filter(Boolean),
    comments: i.comments ?? 0,
    updated_at: i.updated_at || null,
    html_url: i.html_url,
  }));
  return envelope({
    query,
    count: issues.length,
    total_count: data.total_count ?? issues.length,
    incomplete_results: Boolean(data.incomplete_results),
    issues,
  });
}

function formatSearchIssues(raw) {
  const d = raw.data;
  const lines = [`GitHub issue search: "${d.query}"`, `Showing ${d.count} of ~${d.total_count}`];
  if (!d.count) {
    lines.push('No issues matched.');
    return lines.join('\n');
  }
  for (const i of d.issues) {
    const labels = i.labels.length ? ` {${i.labels.join(', ')}}` : '';
    lines.push(`• ${i.repo || ''}#${i.number} — ${i.title} [${i.state}]${labels} (@${i.user || '?'})\n  ${i.html_url}`);
  }
  return lines.join('\n');
}

/** @param {{ repo: string, number: number, include_comments?: boolean }} payload */
async function getIssue(payload = {}) {
  const { owner, repo, full_name, urlHint } = repoFromPayload(payload);
  const number = payload.number ?? urlHint?.number;
  if (number == null || number === '') throw new Error('Missing issue number');
  const github = createGithubClient();
  let issue;
  try {
    issue = await github.getIssue({ owner, repo, number });
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) {
      return { ok: false, source: 'github', confidence: 'high', data: { full_name, number: Number(number), found: false }, error: `Issue not found: ${full_name}#${number}` };
    }
    throw err;
  }
  let comments = [];
  if (payload.include_comments !== false && issue.comments > 0) {
    const list = await github.listIssueComments({ owner, repo, number, per_page: 10 }).catch(() => []);
    comments = (Array.isArray(list) ? list : []).map((c) => ({
      user: c.user?.login || '?',
      created_at: c.created_at,
      body: String(c.body || '').slice(0, 800),
    }));
  }
  return envelope({
    found: true,
    full_name,
    number: issue.number,
    is_pull_request: Boolean(issue.pull_request),
    title: issue.title,
    state: issue.state,
    user: issue.user?.login || null,
    assignees: (issue.assignees || []).map((a) => a.login),
    labels: (issue.labels || []).map((l) => l.name).filter(Boolean),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at || null,
    html_url: issue.html_url,
    body: String(issue.body || '').trim().slice(0, 3500) || '(no description)',
    comments,
  });
}

function formatGetIssue(raw) {
  const d = raw.data;
  if (!d.found) return `Issue not found: ${d.full_name}#${d.number}`;
  const lines = [
    `${d.full_name}#${d.number} — ${d.title}${d.is_pull_request ? ' (pull request — use github_get_pr for diff/CI)' : ''}`,
    `URL: ${d.html_url}`,
    `State: ${d.state} · Author: @${d.user || '?'}${d.assignees.length ? ` · Assignees: ${d.assignees.map((a) => `@${a}`).join(', ')}` : ''}`,
  ];
  if (d.labels.length) lines.push(`Labels: ${d.labels.join(', ')}`);
  lines.push(`Created: ${d.created_at} · Updated: ${d.updated_at}`, '', 'Description:', d.body);
  if (d.comments.length) {
    lines.push('', `Recent comments (${d.comments.length}):`);
    for (const c of d.comments) lines.push(`- @${c.user} (${c.created_at}): ${c.body.slice(0, 400)}`);
  }
  return lines.join('\n');
}

/** @param {{ repo: string, number: number, body: string }} payload */
async function addComment(payload = {}) {
  const { owner, repo, full_name, urlHint } = repoFromPayload(payload);
  const number = payload.number ?? urlHint?.number;
  const body = String(payload.body || '').trim();
  if (number == null || number === '') throw new Error('Missing issue/PR number');
  if (!body) throw new Error('Missing comment body');
  const github = createGithubClient();
  const comment = await github.createIssueComment({ owner, repo, number, body });
  return envelope({ full_name, number: Number(number), comment_id: comment.id, html_url: comment.html_url });
}

function formatAddComment(raw) {
  const d = raw.data;
  return `Commented on ${d.full_name}#${d.number}. URL: ${d.html_url}`;
}

/** @param {{ repo: string, title: string, body?: string, labels?: string, assignees?: string }} payload */
async function createIssue(payload = {}) {
  const { owner, repo, full_name } = repoFromPayload(payload);
  const title = String(payload.title || '').trim();
  if (!title) throw new Error('Missing issue title');
  const github = createGithubClient();
  const issue = await github.createIssue({
    owner,
    repo,
    title,
    body: payload.body ? String(payload.body) : undefined,
    labels: parseList(payload.labels),
    assignees: parseList(payload.assignees).map((a) => a.replace(/^@/, '')),
  });
  return envelope({ full_name, number: issue.number, title: issue.title, html_url: issue.html_url });
}

function formatCreateIssue(raw) {
  const d = raw.data;
  return `Created ${d.full_name}#${d.number} — ${d.title}. URL: ${d.html_url}`;
}

module.exports = {
  searchIssues,
  formatSearchIssues,
  getIssue,
  formatGetIssue,
  addComment,
  formatAddComment,
  createIssue,
  formatCreateIssue,
};
