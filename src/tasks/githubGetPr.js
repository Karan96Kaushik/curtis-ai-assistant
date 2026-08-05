const { createGithubClient, GithubError, parseRepo } = require('../integrations/githubClient');

/**
 * Read a single pull request.
 * @param {{
 *   repo?: string, owner?: string, repository?: string,
 *   number?: number|string, pr?: number|string, pull?: number|string
 * }} payload
 */
async function githubGetPrTask(payload = {}) {
  const number = payload.number ?? payload.pr ?? payload.pull ?? payload.pull_number;
  if (number == null || number === '') {
    throw new Error('Missing PR number');
  }

  const full =
    payload.repo ||
    payload.repository ||
    (payload.owner && payload.name ? `${payload.owner}/${payload.name}` : null);
  if (!full && !payload.owner) {
    throw new Error('Missing repo (expected owner/repo)');
  }

  const { owner, repo } = payload.owner && payload.repo && !String(payload.repo).includes('/')
    ? { owner: String(payload.owner).trim(), repo: String(payload.repo).trim() }
    : parseRepo(full || `${payload.owner}/${payload.repo}`);

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
        full_name: `${owner}/${repo}`,
        number: Number(number),
        error: `PR not found: ${owner}/${repo}#${number}`,
      };
    }
    throw err;
  }

  return {
    ok: true,
    found: true,
    owner,
    repo,
    full_name: `${owner}/${repo}`,
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
      sha: data.head?.sha || null,
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
    body: String(data.body || '').trim() || '(no description)',
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
  lines.push('', 'Description:', String(result.body).slice(0, 3500));
  return lines.join('\n');
}

module.exports = githubGetPrTask;
module.exports.formatResult = formatResult;
