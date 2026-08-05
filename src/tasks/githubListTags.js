const { createGithubClient, GithubError, parseRepo } = require('../integrations/githubClient');

const DEFAULT_MAX = 30;
const HARD_MAX = 100;

/**
 * List (or check) tags on a GitHub repo.
 * @param {{
 *   repo?: string, owner?: string, repository?: string,
 *   tag?: string, check?: string,
 *   max?: number|string
 * }} payload
 */
async function githubListTagsTask(payload = {}) {
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

  let max = Number(payload.max ?? payload.per_page);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX;
  max = Math.min(Math.floor(max), HARD_MAX);

  const checkTag = String(payload.tag || payload.check || '').replace(/^refs\/tags\//, '').trim();

  const github = createGithubClient();
  const tagsRaw = await github.listTags({ owner, repo, per_page: max });
  const tags = (Array.isArray(tagsRaw) ? tagsRaw : []).map((t) => ({
    name: t.name,
    sha: t.commit?.sha || null,
    zipball_url: t.zipball_url || null,
    tarball_url: t.tarball_url || null,
  }));

  let check = null;
  if (checkTag) {
    const found = tags.find((t) => t.name === checkTag);
    if (found) {
      check = { tag: checkTag, exists: true, sha: found.sha };
    } else {
      try {
        const ref = await github.getRef({ owner, repo, ref: `tags/${checkTag}` });
        check = {
          tag: checkTag,
          exists: true,
          sha: ref.object?.sha || null,
          note: 'Found via ref API (may be beyond listed page)',
        };
      } catch (err) {
        if (err instanceof GithubError && err.status === 404) {
          check = { tag: checkTag, exists: false, sha: null };
        } else {
          throw err;
        }
      }
    }
  }

  return {
    owner,
    repo,
    full_name: `${owner}/${repo}`,
    count: tags.length,
    tags,
    check,
    html_url: `https://github.com/${owner}/${repo}/tags`,
  };
}

function formatResult(result) {
  const lines = [
    `Tags for ${result.full_name}: ${result.count} shown`,
    result.html_url,
  ];
  if (result.check) {
    lines.push(
      result.check.exists
        ? `Check: tag "${result.check.tag}" EXISTS (sha ${result.check.sha || '?'})`
        : `Check: tag "${result.check.tag}" does NOT exist`
    );
    if (result.check.note) lines.push(`Note: ${result.check.note}`);
  }
  if (!result.tags?.length) {
    lines.push('No tags found.');
    return lines.join('\n');
  }
  lines.push('');
  for (const t of result.tags) {
    lines.push(`• ${t.name} (${(t.sha || '').slice(0, 7) || '?'})`);
  }
  return lines.join('\n');
}

module.exports = githubListTagsTask;
module.exports.formatResult = formatResult;
