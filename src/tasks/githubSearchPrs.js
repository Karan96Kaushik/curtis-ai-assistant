const { createGithubClient } = require('../integrations/githubClient');

const DEFAULT_MAX = 10;
const HARD_MAX = 50;

/**
 * Search pull requests (GitHub Issues Search with type:pr), or list PRs for a repo.
 * @param {{
 *   query?: string, q?: string,
 *   repo?: string, owner?: string,
 *   state?: string,
 *   max?: number|string,
 *   sort?: string, order?: string
 * }} payload
 */
async function githubSearchPrsTask(payload = {}) {
  let max = Number(payload.max ?? payload.per_page);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX;
  max = Math.min(Math.floor(max), HARD_MAX);

  const github = createGithubClient();
  let query = String(payload.query || payload.q || '').trim();
  const repoFull =
    payload.repo ||
    (payload.owner && payload.name ? `${payload.owner}/${payload.name}` : null);
  const state = payload.state ? String(payload.state).trim().toLowerCase() : '';

  // If only repo given (no free-text query), list that repo's pulls via REST
  if (repoFull && !query) {
    const m = String(repoFull).match(/^([^/\s]+)\/([^/\s]+)$/);
    if (!m) throw new Error('repo must be owner/repo');
    const [owner, repo] = [m[1], m[2]];
    const pulls = await github.listPulls({
      owner,
      repo,
      state: state || 'open',
      per_page: max,
    });
    const items = (Array.isArray(pulls) ? pulls : []).map(mapPullSummary);
    return {
      mode: 'list',
      query: `repo:${owner}/${repo} state:${state || 'open'}`,
      count: items.length,
      total_count: items.length,
      pulls: items,
    };
  }

  if (!query && !repoFull) {
    throw new Error('Missing PR search query (or repo to list)');
  }

  if (repoFull && !/\brepo:/i.test(query)) {
    query = `repo:${repoFull} ${query}`.trim();
  }
  if (state && state !== 'all' && !/\bis:(open|closed|merged)\b/i.test(query)) {
    if (state === 'merged') query = `${query} is:merged`.trim();
    else query = `${query} is:${state}`.trim();
  }

  const data = await github.searchPulls({
    q: query,
    per_page: max,
    sort: payload.sort,
    order: payload.order,
  });

  const pulls = (data.items || []).map((p) => ({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: Boolean(p.draft),
    user: p.user?.login || null,
    html_url: p.html_url,
    created_at: p.created_at || null,
    updated_at: p.updated_at || null,
    closed_at: p.closed_at || null,
    repo: p.repository_url
      ? String(p.repository_url).replace(/^https:\/\/api\.github\.com\/repos\//, '')
      : null,
    labels: Array.isArray(p.labels) ? p.labels.map((l) => l.name).filter(Boolean) : [],
    body_preview: String(p.body || '').slice(0, 200) || null,
  }));

  return {
    mode: 'search',
    query,
    count: pulls.length,
    total_count: data.total_count ?? pulls.length,
    incomplete_results: Boolean(data.incomplete_results),
    pulls,
  };
}

function mapPullSummary(p) {
  return {
    number: p.number,
    title: p.title,
    state: p.merged_at ? 'merged' : p.state,
    draft: Boolean(p.draft),
    user: p.user?.login || null,
    html_url: p.html_url,
    created_at: p.created_at || null,
    updated_at: p.updated_at || null,
    closed_at: p.closed_at || null,
    merged_at: p.merged_at || null,
    head: p.head?.ref || null,
    base: p.base?.ref || null,
    repo: p.base?.repo?.full_name || null,
    labels: Array.isArray(p.labels) ? p.labels.map((l) => l.name).filter(Boolean) : [],
    body_preview: String(p.body || '').slice(0, 200) || null,
  };
}

function formatResult(result) {
  const lines = [
    `GitHub PR ${result.mode}: "${result.query}"`,
    `Showing ${result.count}${result.total_count != null ? ` of ~${result.total_count}` : ''} PR(s)`,
  ];
  if (!result.pulls?.length) {
    lines.push('No pull requests matched.');
    return lines.join('\n');
  }
  for (const p of result.pulls) {
    const draft = p.draft ? ' draft' : '';
    const repo = p.repo ? `${p.repo} ` : '';
    lines.push(
      `• ${repo}#${p.number} — ${p.title} [${p.state}${draft}] (@${p.user || '?'})\n  ${p.html_url}`
    );
  }
  return lines.join('\n');
}

module.exports = githubSearchPrsTask;
module.exports.formatResult = formatResult;
