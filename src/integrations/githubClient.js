class GithubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.body = body;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

const { startTimer } = require('../util/timing');

/**
 * Parse "owner/repo" or separate owner + repo into { owner, repo }.
 * @param {string} ownerOrFull
 * @param {string} [repo]
 * @returns {{ owner: string, repo: string }}
 */
function parseRepo(ownerOrFull, repo) {
  if (repo) {
    return { owner: String(ownerOrFull).trim(), repo: String(repo).trim() };
  }
  const s = String(ownerOrFull || '').trim();
  const m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) {
    throw new Error('Expected repo as "owner/repo" or separate owner + repo');
  }
  return { owner: m[1], repo: m[2] };
}

function createGithubClient(overrides = {}) {
  const token = overrides.token || requireEnv('GITHUB_TOKEN');
  const baseUrl = (
    overrides.baseUrl ||
    process.env.GITHUB_API_BASE_URL ||
    'https://api.github.com'
  ).replace(/\/$/, '');

  async function request(method, path, body) {
    const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ai-assitant-node',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const timer = startTimer(`github.${method} ${path}`);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const text = await response.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }

      if (!response.ok) {
        const detail =
          (data && typeof data === 'object' && (data.message || data.error)) ||
          (typeof data === 'string' ? data : response.statusText);
        let message = `GitHub ${method} ${path} failed (${response.status}): ${detail}`;
        if (response.status === 401 || response.status === 403) {
          message += ' — check GITHUB_TOKEN in .env (scopes: repo for private, public_repo for public)';
        }
        timer.end(`status=${response.status} bytes=${text.length}`);
        throw new GithubError(message, response.status, data);
      }

      timer.end(`status=${response.status} bytes=${text.length}`);
      return data;
    } catch (err) {
      if (!(err instanceof GithubError)) {
        timer.end('FAILED network/parse');
      }
      throw err;
    }
  }

  return {
    baseUrl,

    async getAuthenticatedUser() {
      return request('GET', '/user');
    },

    /**
     * Search repositories.
     * @param {{ q: string, per_page?: number, page?: number, sort?: string, order?: string }} opts
     */
    async searchRepos({ q, per_page = 10, page = 1, sort, order } = {}) {
      const params = new URLSearchParams({
        q: String(q || ''),
        per_page: String(Math.min(Math.max(Number(per_page) || 10, 1), 50)),
        page: String(Math.max(Number(page) || 1, 1)),
      });
      if (sort) params.set('sort', sort);
      if (order) params.set('order', order);
      return request('GET', `/search/repositories?${params}`);
    },

    /**
     * List repos for the authenticated user, or an org if org is set.
     * @param {{ org?: string, type?: string, per_page?: number, page?: number, sort?: string }} opts
     */
    async listRepos({ org, type = 'all', per_page = 30, page = 1, sort = 'updated' } = {}) {
      const params = new URLSearchParams({
        per_page: String(Math.min(Math.max(Number(per_page) || 30, 1), 100)),
        page: String(Math.max(Number(page) || 1, 1)),
        sort: String(sort || 'updated'),
      });
      if (org) {
        params.set('type', type === 'all' ? 'all' : type);
        return request('GET', `/orgs/${encodeURIComponent(org)}/repos?${params}`);
      }
      params.set('affiliation', 'owner,collaborator,organization_member');
      if (type && type !== 'all') params.set('type', type);
      return request('GET', `/user/repos?${params}`);
    },

    /**
     * List tags for a repo.
     * @param {{ owner: string, repo: string, per_page?: number, page?: number }} opts
     */
    async listTags({ owner, repo, per_page = 30, page = 1 } = {}) {
      const params = new URLSearchParams({
        per_page: String(Math.min(Math.max(Number(per_page) || 30, 1), 100)),
        page: String(Math.max(Number(page) || 1, 1)),
      });
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tags?${params}`
      );
    },

    /**
     * List branches for a repo.
     * @param {{ owner: string, repo: string, per_page?: number, page?: number }} opts
     */
    async listBranches({ owner, repo, per_page = 100, page = 1 } = {}) {
      const params = new URLSearchParams({
        per_page: String(Math.min(Math.max(Number(per_page) || 100, 1), 100)),
        page: String(Math.max(Number(page) || 1, 1)),
      });
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?${params}`
      );
    },

    /**
     * List commits on a repo, optionally scoped to a ref and date window.
     * Unlike the search API this sees every branch, not just the default one.
     * @param {{ owner: string, repo: string, sha?: string, since?: string, until?: string, author?: string, per_page?: number, page?: number }} opts
     */
    async listCommits({ owner, repo, sha, since, until, author, per_page = 100, page = 1 } = {}) {
      const params = new URLSearchParams({
        per_page: String(Math.min(Math.max(Number(per_page) || 100, 1), 100)),
        page: String(Math.max(Number(page) || 1, 1)),
      });
      if (sha) params.set('sha', sha);
      if (since) params.set('since', since);
      if (until) params.set('until', until);
      if (author) params.set('author', author);
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${params}`
      );
    },

    /**
     * Resolve a git ref (branch, tag, or SHA).
     * @param {{ owner: string, repo: string, ref: string }} opts
     */
    async getRef({ owner, repo, ref } = {}) {
      const cleaned = String(ref || '').replace(/^refs\//, '');
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/${cleaned}`
      );
    },

    /**
     * Get a commit SHA for a branch name, tag, or raw SHA.
     * @param {{ owner: string, repo: string, shaOrRef: string }} opts
     */
    async resolveSha({ owner, repo, shaOrRef } = {}) {
      const ref = String(shaOrRef || '').trim();
      if (!ref) throw new Error('Missing sha or ref');
      if (/^[0-9a-f]{7,40}$/i.test(ref)) {
        return ref.length === 40 ? ref.toLowerCase() : (await this.getCommit({ owner, repo, ref })).sha;
      }
      try {
        const data = await this.getRef({ owner, repo, ref: `heads/${ref}` });
        return data.object?.sha;
      } catch (err) {
        if (!(err instanceof GithubError) || err.status !== 404) throw err;
      }
      try {
        const data = await this.getRef({ owner, repo, ref: `tags/${ref}` });
        return data.object?.sha;
      } catch (err) {
        if (!(err instanceof GithubError) || err.status !== 404) throw err;
      }
      const commit = await this.getCommit({ owner, repo, ref });
      return commit.sha;
    },

    async getCommit({ owner, repo, ref } = {}) {
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`
      );
    },

    /**
     * Create a lightweight or annotated git tag.
     * @param {{ owner: string, repo: string, tag: string, sha: string, message?: string }} opts
     */
    async createTag({ owner, repo, tag, sha, message } = {}) {
      const tagName = String(tag || '').replace(/^refs\/tags\//, '').trim();
      if (!tagName) throw new Error('Missing tag name');
      if (!sha) throw new Error('Missing commit SHA');

      let objectSha = sha;
      if (message) {
        const me = await this.getAuthenticatedUser();
        const tagObj = await request(
          'POST',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/tags`,
          {
            tag: tagName,
            message: String(message),
            object: sha,
            type: 'commit',
            tagger: {
              name: me.name || me.login || 'ai-assistant',
              email: me.email || `${me.login}@users.noreply.github.com`,
              date: new Date().toISOString(),
            },
          }
        );
        objectSha = tagObj.sha;
      }

      const ref = await request(
        'POST',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`,
        {
          ref: `refs/tags/${tagName}`,
          sha: objectSha,
        }
      );

      return {
        tag: tagName,
        sha,
        annotated: Boolean(message),
        ref: ref.ref,
        url: `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tagName)}`,
        html_url: `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(tagName)}`,
      };
    },

    /**
     * Search issues/PRs via Issues Search API.
     * @param {{ q: string, per_page?: number, page?: number, sort?: string, order?: string }} opts
     */
    async searchIssues({ q, per_page = 50, page = 1, sort, order } = {}) {
      const params = new URLSearchParams({
        q: String(q || '').trim(),
        per_page: String(Math.min(Math.max(Number(per_page) || 50, 1), 100)),
        page: String(Math.max(Number(page) || 1, 1)),
      });
      if (sort) params.set('sort', sort);
      if (order) params.set('order', order);
      return request('GET', `/search/issues?${params}`);
    },

    /**
     * Search pull requests via Issues Search API (type:pr).
     * @param {{ q: string, per_page?: number, page?: number, sort?: string, order?: string }} opts
     */
    async searchPulls({ q, per_page = 10, page = 1, sort, order } = {}) {
      let query = String(q || '').trim();
      if (!/\btype:pr\b/i.test(query)) {
        query = `${query} type:pr`.trim();
      }
      return this.searchIssues({ q: query, per_page, page, sort, order });
    },

    /**
     * Search commits via Commits Search API.
     * @param {{ q: string, per_page?: number, page?: number, sort?: string, order?: string }} opts
     */
    async searchCommits({ q, per_page = 50, page = 1, sort, order } = {}) {
      const params = new URLSearchParams({
        q: String(q || '').trim(),
        per_page: String(Math.min(Math.max(Number(per_page) || 50, 1), 100)),
        page: String(Math.max(Number(page) || 1, 1)),
      });
      if (sort) params.set('sort', sort);
      if (order) params.set('order', order);
      return request('GET', `/search/commits?${params}`);
    },

    /**
     * List pulls for a repo.
     * @param {{ owner: string, repo: string, state?: string, per_page?: number, page?: number }} opts
     */
    async listPulls({ owner, repo, state = 'open', per_page = 20, page = 1 } = {}) {
      const params = new URLSearchParams({
        state: String(state || 'open'),
        per_page: String(Math.min(Math.max(Number(per_page) || 20, 1), 100)),
        page: String(Math.max(Number(page) || 1, 1)),
        sort: 'updated',
        direction: 'desc',
      });
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params}`
      );
    },

    /**
     * Get a single pull request.
     * @param {{ owner: string, repo: string, number: number|string }} opts
     */
    async getPull({ owner, repo, number } = {}) {
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`
      );
    },

    /**
     * List commits on a pull request.
     * @param {{ owner: string, repo: string, number: number|string, per_page?: number }} opts
     */
    async listPullCommits({ owner, repo, number, per_page = 100 } = {}) {
      const params = new URLSearchParams({
        per_page: String(Math.min(Math.max(Number(per_page) || 100, 1), 100)),
      });
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/commits?${params}`
      );
    },

    /**
     * List files changed on a pull request.
     * @param {{ owner: string, repo: string, number: number|string, per_page?: number }} opts
     */
    async listPullFiles({ owner, repo, number, per_page = 100 } = {}) {
      const params = new URLSearchParams({
        per_page: String(Math.min(Math.max(Number(per_page) || 100, 1), 100)),
      });
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/files?${params}`
      );
    },

    /**
     * Combined commit status for a ref/SHA.
     * @param {{ owner: string, repo: string, ref: string }} opts
     */
    async getCombinedStatus({ owner, repo, ref } = {}) {
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/status`
      );
    },

    /**
     * Check runs for a ref/SHA.
     * @param {{ owner: string, repo: string, ref: string, per_page?: number }} opts
     */
    async listCheckRuns({ owner, repo, ref, per_page = 50 } = {}) {
      const params = new URLSearchParams({
        per_page: String(Math.min(Math.max(Number(per_page) || 50, 1), 100)),
      });
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs?${params}`
      );
    },

    /**
     * Compare two commits/refs.
     * @param {{ owner: string, repo: string, base: string, head: string }} opts
     */
    async compareCommits({ owner, repo, base, head } = {}) {
      return request(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
      );
    },
  };
}

module.exports = {
  createGithubClient,
  GithubError,
  parseRepo,
};
