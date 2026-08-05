const { createGithubClient } = require('../integrations/githubClient');

const DEFAULT_MAX = 10;
const HARD_MAX = 50;

/**
 * Search GitHub repositories.
 * @param {{ query?: string, q?: string, max?: number|string, sort?: string, order?: string }} payload
 */
async function githubSearchReposTask(payload = {}) {
  const query = String(payload.query || payload.q || '').trim();
  if (!query) throw new Error('Missing search query');

  let max = Number(payload.max ?? payload.per_page);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX;
  max = Math.min(Math.floor(max), HARD_MAX);

  const github = createGithubClient();
  const data = await github.searchRepos({
    q: query,
    per_page: max,
    sort: payload.sort,
    order: payload.order,
  });

  const repos = (data.items || []).map((r) => ({
    full_name: r.full_name,
    name: r.name,
    owner: r.owner?.login || null,
    description: r.description || null,
    private: Boolean(r.private),
    html_url: r.html_url,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    language: r.language || null,
    updated_at: r.updated_at || null,
    default_branch: r.default_branch || null,
  }));

  return {
    query,
    count: repos.length,
    total_count: data.total_count ?? repos.length,
    incomplete_results: Boolean(data.incomplete_results),
    repos,
  };
}

function formatResult(result) {
  const lines = [
    `GitHub repo search: "${result.query}"`,
    `Showing ${result.count} of ~${result.total_count} result(s)`,
  ];
  if (!result.repos?.length) {
    lines.push('No repositories matched.');
    return lines.join('\n');
  }
  for (const r of result.repos) {
    const vis = r.private ? 'private' : 'public';
    const lang = r.language ? ` · ${r.language}` : '';
    const desc = r.description ? ` — ${r.description.slice(0, 120)}` : '';
    lines.push(
      `• ${r.full_name} [${vis}${lang}] ★${r.stars}${desc}\n  ${r.html_url}`
    );
  }
  return lines.join('\n');
}

module.exports = githubSearchReposTask;
module.exports.formatResult = formatResult;
