/**
 * Read-only repo tools: repo details, branches, commits, compare, file contents.
 */

const { createGithubClient, GithubError, repoFromPayload } = require('../integrations/githubClient');
const { jiraKeysIn, jiraIssuesForKeys } = require('../integrations/crossLink');

const FILE_MAX_CHARS = 12000;

function envelope(data) {
  return { ok: true, source: 'github', confidence: 'high', data };
}

function clampMax(raw, fallback, hard) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), hard);
}

function notFound(what, err) {
  if (err instanceof GithubError && err.status === 404) {
    return new Error(`${what} not found (or the token cannot see it)`);
  }
  return err;
}

function firstLine(message) {
  return String(message || '').split('\n')[0].slice(0, 160);
}

function decodeContent(file) {
  if (file.encoding === 'base64' && file.content) {
    return Buffer.from(file.content, 'base64').toString('utf8');
  }
  return String(file.content || '');
}

/** @param {{ repo: string, include_readme?: boolean }} payload */
async function getRepo(payload = {}) {
  const { owner, repo, full_name } = repoFromPayload(payload);
  const github = createGithubClient();
  let r;
  try {
    r = await github.getRepo({ owner, repo });
  } catch (err) {
    throw notFound(`Repo ${full_name}`, err);
  }
  let readme = null;
  if (payload.include_readme === true || payload.include_readme === 'true') {
    readme = await github
      .getReadme({ owner, repo })
      .then((f) => decodeContent(f).slice(0, 3000))
      .catch(() => null);
  }
  return envelope({
    full_name: r.full_name,
    html_url: r.html_url,
    description: r.description || null,
    private: Boolean(r.private),
    archived: Boolean(r.archived),
    default_branch: r.default_branch,
    language: r.language || null,
    topics: r.topics || [],
    stars: r.stargazers_count ?? 0,
    open_issues: r.open_issues_count ?? 0,
    pushed_at: r.pushed_at || null,
    updated_at: r.updated_at || null,
    readme,
  });
}

function formatGetRepo(raw) {
  const d = raw.data;
  const lines = [
    `${d.full_name}${d.private ? ' (private)' : ''}${d.archived ? ' (archived)' : ''}`,
    `URL: ${d.html_url}`,
    d.description ? `Description: ${d.description}` : null,
    `Default branch: ${d.default_branch} · Language: ${d.language || '?'} · Open issues+PRs: ${d.open_issues}`,
    d.topics.length ? `Topics: ${d.topics.join(', ')}` : null,
    d.pushed_at ? `Last push: ${d.pushed_at}` : null,
  ].filter(Boolean);
  if (d.readme) lines.push('', 'README (excerpt):', d.readme);
  return lines.join('\n');
}

/** @param {{ repo: string, filter?: string, max?: number }} payload */
async function listBranches(payload = {}) {
  const { owner, repo, full_name } = repoFromPayload(payload);
  const max = clampMax(payload.max, 50, 100);
  const filter = String(payload.filter || '').trim().toLowerCase();
  const github = createGithubClient();
  let branches;
  try {
    branches = await github.listBranches({ owner, repo, per_page: 100 });
  } catch (err) {
    throw notFound(`Repo ${full_name}`, err);
  }
  const all = (Array.isArray(branches) ? branches : []).map((b) => ({
    name: b.name,
    sha: b.commit?.sha || null,
    protected: Boolean(b.protected),
  }));
  const matched = filter ? all.filter((b) => b.name.toLowerCase().includes(filter)) : all;
  return envelope({
    full_name,
    filter: filter || null,
    count: matched.length,
    truncated: all.length === 100,
    branches: matched.slice(0, max),
  });
}

function formatListBranches(raw) {
  const d = raw.data;
  const lines = [`${d.full_name}: ${d.count} branch(es)${d.filter ? ` matching "${d.filter}"` : ''}${d.truncated ? ' (first 100 scanned)' : ''}`];
  for (const b of d.branches) lines.push(`• ${b.name}${b.protected ? ' (protected)' : ''} ${b.sha ? b.sha.slice(0, 7) : ''}`);
  return lines.join('\n');
}

/**
 * @param {{ repo: string, branch?: string, since?: string, until?: string, author?: string, path?: string, max?: number }} payload
 */
async function listCommits(payload = {}) {
  const { owner, repo, full_name } = repoFromPayload(payload);
  const max = clampMax(payload.max, 20, 100);
  const github = createGithubClient();
  let commits;
  try {
    commits = await github.listCommits({
      owner,
      repo,
      sha: payload.branch || payload.ref || undefined,
      since: payload.since || undefined,
      until: payload.until || undefined,
      author: payload.author || undefined,
      path: payload.path || undefined,
      per_page: max,
    });
  } catch (err) {
    throw notFound(`Repo or ref ${full_name}${payload.branch ? `@${payload.branch}` : ''}`, err);
  }
  const items = (Array.isArray(commits) ? commits : []).map((c) => ({
    sha: c.sha,
    message: firstLine(c.commit?.message),
    author: c.author?.login || c.commit?.author?.name || null,
    date: c.commit?.author?.date || null,
    html_url: c.html_url,
  }));
  return envelope({
    full_name,
    branch: payload.branch || null,
    path: payload.path || null,
    count: items.length,
    commits: items,
  });
}

function formatListCommits(raw) {
  const d = raw.data;
  const scope = [d.branch && `@${d.branch}`, d.path && `path ${d.path}`].filter(Boolean).join(' ');
  const lines = [`${d.full_name}${scope ? ` ${scope}` : ''}: ${d.count} commit(s)`];
  for (const c of d.commits) {
    lines.push(`• ${c.sha.slice(0, 7)} ${c.date ? c.date.slice(0, 10) : ''} @${c.author || '?'} — ${c.message}`);
  }
  return lines.join('\n');
}

/** @param {{ repo: string, base: string, head?: string }} payload */
async function compare(payload = {}) {
  const { owner, repo, full_name } = repoFromPayload(payload);
  const base = String(payload.base || '').trim();
  if (!base) throw new Error('Missing base (tag, branch, or SHA)');
  const github = createGithubClient();
  let head = String(payload.head || '').trim();
  if (!head) {
    head = (await github.getRepo({ owner, repo })).default_branch;
  }
  let data;
  try {
    data = await github.compareCommits({ owner, repo, base, head });
  } catch (err) {
    throw notFound(`Comparison ${full_name} ${base}...${head}`, err);
  }
  const commits = (data.commits || []).map((c) => ({
    sha: c.sha,
    message: firstLine(c.commit?.message),
    author: c.author?.login || c.commit?.author?.name || null,
  }));
  const files = (data.files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
  }));
  const keys = jiraKeysIn(...(data.commits || []).map((c) => c.commit?.message));
  const jiraIssues = await jiraIssuesForKeys(keys, { max: 10 });
  return envelope({
    full_name,
    base,
    head,
    status: data.status,
    ahead_by: data.ahead_by,
    behind_by: data.behind_by,
    total_commits: data.total_commits ?? commits.length,
    html_url: data.html_url,
    commits: commits.slice(-50),
    files: files.slice(0, 60),
    file_count: files.length,
    jiraIssues,
  });
}

function formatCompare(raw) {
  const d = raw.data;
  const lines = [
    `${d.full_name}: ${d.base}...${d.head} — ${d.status} (ahead ${d.ahead_by}, behind ${d.behind_by})`,
    `URL: ${d.html_url}`,
    `${d.total_commits} commit(s), ${d.file_count} file(s) changed`,
  ];
  if (d.commits.length) {
    lines.push('', d.total_commits > d.commits.length ? `Latest ${d.commits.length} commits:` : 'Commits:');
    for (const c of d.commits) lines.push(`• ${c.sha.slice(0, 7)} @${c.author || '?'} — ${c.message}`);
  }
  if (d.files.length) {
    lines.push('', 'Files:');
    for (const f of d.files) lines.push(`• ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`);
    if (d.file_count > d.files.length) lines.push(`…and ${d.file_count - d.files.length} more`);
  }
  if (d.jiraIssues.length) {
    lines.push('', 'Jira issues referenced in these commits:');
    for (const i of d.jiraIssues) lines.push(`• ${i.key} — ${i.summary} [${i.status}] ${i.browseUrl}`);
  }
  return lines.join('\n');
}

/** @param {{ repo: string, path?: string, ref?: string }} payload */
async function getFile(payload = {}) {
  const { owner, repo, full_name } = repoFromPayload(payload);
  const path = String(payload.path || '').trim();
  const ref = payload.ref || payload.branch || undefined;
  const github = createGithubClient();
  let data;
  try {
    data = await github.getContent({ owner, repo, path, ref });
  } catch (err) {
    throw notFound(`${full_name}/${path || ''}${ref ? `@${ref}` : ''}`, err);
  }
  if (Array.isArray(data)) {
    return envelope({
      full_name,
      path,
      ref: ref || null,
      kind: 'dir',
      entries: data.map((e) => ({ name: e.name, type: e.type, size: e.size })),
    });
  }
  if (data.type !== 'file') {
    return envelope({ full_name, path, ref: ref || null, kind: data.type, entries: [] });
  }
  const text = decodeContent(data);
  return envelope({
    full_name,
    path: data.path,
    ref: ref || null,
    kind: 'file',
    size: data.size,
    html_url: data.html_url,
    truncated: text.length > FILE_MAX_CHARS,
    content: text.slice(0, FILE_MAX_CHARS),
  });
}

function formatGetFile(raw) {
  const d = raw.data;
  const where = `${d.full_name}${d.path ? `/${d.path}` : ' (root)'}${d.ref ? `@${d.ref}` : ''}`;
  if (d.kind === 'dir') {
    return [`${where} (directory, ${d.entries.length} entries):`, ...d.entries.map((e) => `• ${e.type === 'dir' ? `${e.name}/` : e.name}`)].join('\n');
  }
  if (d.kind !== 'file') return `${where} is a ${d.kind}, not a readable file.`;
  return [
    `${where} (${d.size} bytes)${d.truncated ? ` — showing first ${FILE_MAX_CHARS} chars` : ''}`,
    `URL: ${d.html_url}`,
    '',
    d.content,
  ].join('\n');
}

module.exports = {
  getRepo,
  formatGetRepo,
  listBranches,
  formatListBranches,
  listCommits,
  formatListCommits,
  compare,
  formatCompare,
  getFile,
  formatGetFile,
};
