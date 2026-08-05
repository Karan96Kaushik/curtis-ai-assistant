const { createGithubClient, parseRepo } = require('../integrations/githubClient');

/**
 * Create a git tag on a GitHub repo (lightweight, or annotated if message set).
 * @param {{
 *   repo?: string, owner?: string, repository?: string,
 *   tag: string, sha?: string, ref?: string, branch?: string,
 *   message?: string
 * }} payload
 */
async function githubCreateTagTask(payload = {}) {
  const tag = String(payload.tag || payload.name || '').replace(/^refs\/tags\//, '').trim();
  if (!tag) throw new Error('Missing tag name');

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

  const shaOrRef = String(
    payload.sha || payload.ref || payload.branch || payload.commit || 'HEAD'
  ).trim();

  const github = createGithubClient();
  const sha = await github.resolveSha({ owner, repo, shaOrRef });
  if (!sha) throw new Error(`Could not resolve commit for "${shaOrRef}"`);

  const created = await github.createTag({
    owner,
    repo,
    tag,
    sha,
    message: payload.message ? String(payload.message) : undefined,
  });

  return {
    ok: true,
    owner,
    repo,
    full_name: `${owner}/${repo}`,
    tag: created.tag,
    sha,
    annotated: created.annotated,
    ref: created.ref,
    url: created.url,
    html_url: created.html_url,
    from: shaOrRef,
  };
}

function formatResult(result) {
  return [
    `Created tag ${result.tag} on ${result.full_name}`,
    `Commit: ${result.sha}`,
    `Type: ${result.annotated ? 'annotated' : 'lightweight'}`,
    `From: ${result.from}`,
    `URL: ${result.html_url || result.url}`,
  ].join('\n');
}

module.exports = githubCreateTagTask;
module.exports.formatResult = formatResult;
