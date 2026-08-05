const { createGithubClient } = require('../integrations/githubClient');

const DEFAULT_MAX = 30;
const HARD_MAX = 100;

/**
 * List repos for the authenticated user, or for an org.
 * @param {{ org?: string, type?: string, max?: number|string, sort?: string }} payload
 */
async function githubListReposTask(payload = {}) {
  let max = Number(payload.max ?? payload.per_page);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX;
  max = Math.min(Math.floor(max), HARD_MAX);

  const org = payload.org ? String(payload.org).trim() : '';
  const type = payload.type ? String(payload.type).trim() : 'all';
  const sort = payload.sort ? String(payload.sort).trim() : 'updated';

  const github = createGithubClient();
  const me = await github.getAuthenticatedUser();
  const data = await github.listRepos({
    org: org || undefined,
    type,
    per_page: max,
    sort,
  });

  const repos = (Array.isArray(data) ? data : []).map((r) => ({
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
    login: me.login || null,
    org: org || null,
    type,
    count: repos.length,
    repos,
  };
}

function formatResult(result) {
  const scope = result.org
    ? `org/${result.org}`
    : `user/${result.login || '?'}`;
  const lines = [`GitHub repos (${scope}, type=${result.type}): ${result.count}`];
  if (!result.repos?.length) {
    lines.push('No repositories found.');
    return lines.join('\n');
  }
  for (const r of result.repos) {
    const vis = r.private ? 'private' : 'public';
    const lang = r.language ? ` · ${r.language}` : '';
    const desc = r.description ? ` — ${r.description.slice(0, 100)}` : '';
    lines.push(`• ${r.full_name} [${vis}${lang}] ★${r.stars}${desc}\n  ${r.html_url}`);
  }
  return lines.join('\n');
}

module.exports = githubListReposTask;
module.exports.formatResult = formatResult;
