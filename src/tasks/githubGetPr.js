const { createGithubClient, GithubError, repoFromPayload } = require('../integrations/githubClient');
const { jiraKeysIn, jiraIssuesForKeys } = require('../integrations/crossLink');

const INCLUDE_OPTIONS = ['checks', 'reviews', 'files', 'commits', 'comments'];
const DEFAULT_INCLUDE = ['checks', 'reviews'];

/**
 * @param {unknown} raw "files,checks" | ["files"] | "all" | undefined
 * @returns {Set<string>}
 */
function parseInclude(raw) {
  if (raw == null || raw === '') return new Set(DEFAULT_INCLUDE);
  const items = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  if (items.includes('all')) return new Set(INCLUDE_OPTIONS);
  if (items.includes('none')) return new Set();
  return new Set(items.filter((i) => INCLUDE_OPTIONS.includes(i)));
}

/** Collapse check runs + legacy statuses into one CI verdict. */
function summarizeChecks(combined, runs) {
  const checks = [
    ...(runs?.check_runs || []).map((r) => ({
      name: r.name,
      state: r.status !== 'completed' ? r.status : r.conclusion || 'unknown',
      url: r.html_url || null,
      description: r.output?.title || null,
    })),
    ...(combined?.statuses || []).map((s) => ({
      name: s.context,
      state: s.state,
      url: s.target_url || null,
      description: s.description || null,
    })),
  ];
  const failing = checks.filter((c) => ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(c.state));
  const pending = checks.filter((c) => ['queued', 'in_progress', 'pending', 'waiting', 'requested'].includes(c.state));
  const overall = !checks.length ? 'none' : failing.length ? 'failing' : pending.length ? 'pending' : 'passing';
  return { overall, total: checks.length, failing, pending, checks };
}

/** Latest review per reviewer (GitHub returns the full history). */
function summarizeReviews(reviews) {
  const latest = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (!r.user?.login || (r.state === 'COMMENTED' && latest.has(r.user.login))) continue;
    latest.set(r.user.login, { user: r.user.login, state: r.state, submitted_at: r.submitted_at || null });
  }
  return [...latest.values()];
}

/**
 * Read a single pull request.
 * @param {{
 *   repo?: string, owner?: string, repository?: string, url?: string,
 *   number?: number|string, pr?: number|string, pull?: number|string,
 *   include?: string|string[]
 * }} payload
 */
async function githubGetPrTask(payload = {}) {
  const { owner, repo, full_name, urlHint } = repoFromPayload(payload);
  const number =
    payload.number ?? payload.pr ?? payload.pull ?? payload.pull_number ?? urlHint?.number;
  if (number == null || number === '') {
    throw new Error('Missing PR number');
  }
  const include = parseInclude(payload.include);

  const github = createGithubClient();
  let data;
  try {
    data = await github.getPull({ owner, repo, number });
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) {
      return {
        ok: false,
        found: false,
        owner,
        repo,
        full_name,
        number: Number(number),
        error: `PR not found: ${full_name}#${number}`,
      };
    }
    throw err;
  }

  const headSha = data.head?.sha;
  const soft = (p) => p.catch((err) => ({ __error: String(err.message || err) }));
  const [combined, runs, reviews, files, commits, comments, jiraIssues] = await Promise.all([
    include.has('checks') && headSha ? soft(github.getCombinedStatus({ owner, repo, ref: headSha })) : null,
    include.has('checks') && headSha ? soft(github.listCheckRuns({ owner, repo, ref: headSha })) : null,
    include.has('reviews') ? soft(github.listPullReviews({ owner, repo, number })) : null,
    include.has('files') ? soft(github.listPullFiles({ owner, repo, number })) : null,
    include.has('commits') ? soft(github.listPullCommits({ owner, repo, number })) : null,
    include.has('comments') ? soft(github.listIssueComments({ owner, repo, number, per_page: 20 })) : null,
    jiraIssuesForKeys(jiraKeysIn(data.title, data.head?.ref, data.body)),
  ]);

  const warnings = [combined, runs, reviews, files, commits, comments]
    .filter((x) => x?.__error)
    .map((x) => x.__error);

  return {
    ok: true,
    found: true,
    owner,
    repo,
    full_name,
    number: data.number,
    title: data.title,
    state: data.merged_at ? 'merged' : data.state,
    draft: Boolean(data.draft),
    user: data.user?.login || null,
    html_url: data.html_url,
    created_at: data.created_at || null,
    updated_at: data.updated_at || null,
    closed_at: data.closed_at || null,
    merged_at: data.merged_at || null,
    mergeable: data.mergeable ?? null,
    mergeable_state: data.mergeable_state || null,
    head: {
      ref: data.head?.ref || null,
      sha: headSha || null,
      label: data.head?.label || null,
    },
    base: {
      ref: data.base?.ref || null,
      sha: data.base?.sha || null,
      label: data.base?.label || null,
    },
    additions: data.additions ?? null,
    deletions: data.deletions ?? null,
    changed_files: data.changed_files ?? null,
    commits: data.commits ?? null,
    comments: data.comments ?? null,
    review_comments: data.review_comments ?? null,
    labels: Array.isArray(data.labels) ? data.labels.map((l) => l.name).filter(Boolean) : [],
    requested_reviewers: (data.requested_reviewers || []).map((r) => r.login),
    body: String(data.body || '').trim() || '(no description)',
    ci: include.has('checks') && !combined?.__error && !runs?.__error ? summarizeChecks(combined, runs) : null,
    reviews: Array.isArray(reviews) ? summarizeReviews(reviews) : null,
    files: Array.isArray(files)
      ? files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }))
      : null,
    commit_list: Array.isArray(commits)
      ? commits.map((c) => ({
          sha: c.sha,
          message: String(c.commit?.message || '').split('\n')[0].slice(0, 160),
          author: c.author?.login || c.commit?.author?.name || null,
        }))
      : null,
    comment_list: Array.isArray(comments)
      ? comments.map((c) => ({ user: c.user?.login || '?', created_at: c.created_at, body: String(c.body || '').slice(0, 600) }))
      : null,
    jiraIssues,
    warning: warnings.length ? warnings.join('; ') : undefined,
  };
}

function formatResult(result) {
  if (!result?.found) {
    return [
      `PR not found: ${result?.full_name || '?'}#${result?.number || '?'}`,
      'This was an exact PR lookup, not a search.',
    ].join('\n');
  }

  const lines = [
    `${result.full_name}#${result.number} — ${result.title}`,
    `URL: ${result.html_url}`,
    `State: ${result.state}${result.draft ? ' (draft)' : ''} · Author: @${result.user || '?'}`,
    `Head: ${result.head?.label || result.head?.ref || '?'} → Base: ${result.base?.label || result.base?.ref || '?'}`,
  ];
  if (result.mergeable != null) {
    lines.push(`Mergeable: ${result.mergeable} (${result.mergeable_state || '?'})`);
  }
  const stats = [];
  if (result.additions != null) stats.push(`+${result.additions}`);
  if (result.deletions != null) stats.push(`-${result.deletions}`);
  if (result.changed_files != null) stats.push(`${result.changed_files} files`);
  if (result.commits != null) stats.push(`${result.commits} commits`);
  if (stats.length) lines.push(`Diff: ${stats.join(' · ')}`);
  if (result.labels?.length) lines.push(`Labels: ${result.labels.join(', ')}`);
  if (result.created_at) lines.push(`Created: ${result.created_at}`);
  if (result.updated_at) lines.push(`Updated: ${result.updated_at}`);
  if (result.merged_at) lines.push(`Merged: ${result.merged_at}`);

  if (result.ci) {
    const c = result.ci;
    lines.push(`CI: ${c.overall}${c.total ? ` (${c.total} checks)` : ''}`);
    for (const f of c.failing.slice(0, 10)) lines.push(`  ✗ ${f.name} — ${f.state}${f.url ? ` ${f.url}` : ''}`);
    for (const p of c.pending.slice(0, 5)) lines.push(`  … ${p.name} — ${p.state}`);
  }
  if (result.reviews) {
    lines.push(
      result.reviews.length
        ? `Reviews: ${result.reviews.map((r) => `@${r.user} ${r.state.toLowerCase().replace('_', ' ')}`).join(', ')}`
        : 'Reviews: none yet'
    );
  }
  if (result.requested_reviewers?.length) {
    lines.push(`Awaiting review from: ${result.requested_reviewers.map((r) => `@${r}`).join(', ')}`);
  }
  if (result.jiraIssues?.length) {
    lines.push('Jira issues referenced:');
    for (const i of result.jiraIssues) lines.push(`  ${i.key} — ${i.summary} [${i.status}] ${i.browseUrl}`);
  }
  if (result.files) {
    lines.push('', `Files (${result.files.length}):`);
    for (const f of result.files.slice(0, 60)) lines.push(`• ${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`);
  }
  if (result.commit_list) {
    lines.push('', `Commits (${result.commit_list.length}):`);
    for (const c of result.commit_list.slice(0, 40)) lines.push(`• ${c.sha.slice(0, 7)} @${c.author || '?'} — ${c.message}`);
  }
  if (result.comment_list?.length) {
    lines.push('', `Conversation (${result.comment_list.length}):`);
    for (const c of result.comment_list) lines.push(`- @${c.user} (${c.created_at}): ${c.body.slice(0, 300)}`);
  }
  if (result.warning) lines.push('', `Partial data: ${result.warning}`);
  lines.push('', 'Description:', String(result.body).slice(0, 3500));
  return lines.join('\n');
}

module.exports = githubGetPrTask;
module.exports.formatResult = formatResult;
module.exports.summarizeChecks = summarizeChecks;
module.exports.summarizeReviews = summarizeReviews;
module.exports.parseInclude = parseInclude;
