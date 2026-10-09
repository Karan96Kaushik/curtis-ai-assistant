class GithubError extends Error {
  constructor(message, status, body, extras = {}) {
    super(message);
    this.name = 'GithubError';
    this.status = status;
    this.body = body;
    this.rateLimited = Boolean(extras.rateLimited);
    this.retryAfterMs = extras.retryAfterMs ?? null;
  }
}

const { sleep, createLimiter, parseRetryAfterMs } = require('../util/rateLimiter');

/** Authenticated search is 30 req/min; space starts so we stay under that. */
const SEARCH_MIN_INTERVAL_MS = 2100;
const REST_MIN_INTERVAL_MS = 150;
const REST_MAX_CONCURRENT = 2;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const SECONDARY_RATE_LIMIT_FLOOR_MS = 60_000;
const RATE_LIMIT_CAP_MS = 5 * 60_000;

/**
 * Shared across client instances — GitHub rates the token, not the process.
 * Search is serial; other REST is lightly concurrent with a small gap so we
 * do not trip the secondary (abuse) limit.
 */
const searchLimiter = createLimiter({ maxConcurrent: 1, minIntervalMs: SEARCH_MIN_INTERVAL_MS });
const restLimiter = createLimiter({ maxConcurrent: REST_MAX_CONCURRENT, minIntervalMs: REST_MIN_INTERVAL_MS });

function isSearchPath(path) {
  return /\/search\//.test(path);
}

function limiterFor(path) {
  return isSearchPath(path) ? searchLimiter : restLimiter;
}

function rateLimitMessage(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  return String(data.message || data.error || '');
}

function isRateLimited(status, data) {
  if (status === 429) return true;
  if (status !== 403) return false;
  const msg = rateLimitMessage(data).toLowerCase();
  return msg.includes('rate limit') || msg.includes('abuse detection');
}

function resetWaitMs(headers) {
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining == null || Number(remaining) > 0) return null;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (!Number.isFinite(reset)) return null;
  return Math.max(reset * 1000 - Date.now(), 0) + 500;
}

function retryDelayMs(response, data, attempt) {
  const msg = rateLimitMessage(data);
  const secondary = /secondary rate limit/i.test(msg);
  const floor = secondary ? SECONDARY_RATE_LIMIT_FLOOR_MS : 5_000;
  const exponential = Math.min(floor * 2 ** attempt, RATE_LIMIT_CAP_MS);
  return Math.max(
    parseRetryAfterMs(response.headers) || 0,
    resetWaitMs(response.headers) || 0,
    exponential
  );
}

/** Token-wide pause so a 403 secondary limit stops the rest of the burst. */
let cooldownUntil = 0;

async function waitForCooldown() {
  const wait = cooldownUntil - Date.now();
  if (wait > 0) await sleep(wait);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

const { startTimer } = require('../util/timing');

const GITHUB_RESERVED_OWNERS = new Set([
  'settings',
  'notifications',
  'issues',
  'pulls',
  'marketplace',
  'explore',
  'topics',
  'orgs',
  'organizations',
  'users',
  'search',
  'login',
  'signup',
  'new',
  'dashboard',
  'gist',
  'collections',
  'sponsors',
  'about',
  'pricing',
  'features',
  'enterprise',
  'team',
  'solutions',
  'resources',
  'copilot',
  'codespaces',
  'security',
  'apps',
]);

/**
 * Parse a github.com link from free text.
 * @param {string} text
 * @returns {{
 *   kind: 'repo'|'pull'|'issue'|'tags'|'commit'|'org'|'user'|'site',
 *   owner: string|null,
 *   repo: string|null,
 *   full_name: string|null,
 *   number?: number|null,
 *   tag?: string|null,
 *   sha?: string|null,
 * } | null}
 */
function parseGithubUrl(text) {
  const s = String(text || '');
  const m = s.match(/(?:^|[\s<("'])(?:https?:\/\/)?(?:www\.)?github\.com\/([^\s<>)"']+)/i);
  if (!m) return null;

  const path = String(m[1] || '')
    .replace(/[.,;:!?]+$/, '')
    .replace(/\/+$/, '')
    .split('?')[0]
    .split('#')[0];
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return { kind: 'site', owner: null, repo: null, full_name: null };

  if (parts[0].toLowerCase() === 'orgs' && parts[1]) {
    return { kind: 'org', owner: parts[1], repo: null, full_name: null };
  }

  const owner = parts[0];
  if (GITHUB_RESERVED_OWNERS.has(owner.toLowerCase())) {
    return { kind: 'site', owner: null, repo: null, full_name: null };
  }

  const repo = parts[1] || null;
  if (!repo) {
    return { kind: 'user', owner, repo: null, full_name: null };
  }

  const restKind = (parts[2] || 'repo').toLowerCase();
  const rest = parts.slice(3);
  const full_name = `${owner}/${repo}`;

  if (restKind === 'pull' || restKind === 'pulls') {
    const number = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null;
    return { kind: 'pull', owner, repo, full_name, number };
  }
  if (restKind === 'issues') {
    const number = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest[0]) : null;
    return { kind: 'issue', owner, repo, full_name, number };
  }
  if (restKind === 'releases' || restKind === 'tags') {
    const tag = restKind === 'releases' && rest[0] === 'tag' ? rest[1] : rest[0];
    return { kind: 'tags', owner, repo, full_name, tag: tag || null };
  }
  if (restKind === 'commit' || restKind === 'commits') {
    return { kind: 'commit', owner, repo, full_name, sha: rest[0] || null };
  }
  return { kind: 'repo', owner, repo, full_name };
}

/**
 * Parse "owner/repo", a github.com URL, or separate owner + repo into { owner, repo }.
 * @param {string} ownerOrFull
 * @param {string} [repo]
 * @returns {{ owner: string, repo: string }}
 */
function parseRepo(ownerOrFull, repo) {
  if (repo) {
    return { owner: String(ownerOrFull).trim(), repo: String(repo).trim() };
  }
  const s = String(ownerOrFull || '').trim();
  const fromUrl = parseGithubUrl(s);
  if (fromUrl?.owner && fromUrl?.repo) {
    return { owner: fromUrl.owner, repo: fromUrl.repo };
  }
  const m = s.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) {
    throw new Error('Expected repo as "owner/repo", a github.com URL, or separate owner + repo');
  }
  return { owner: m[1], repo: m[2] };
}

function isGithubConfigured() {
  return Boolean(process.env.GITHUB_TOKEN);
}

/** @type {{ key: string, client: object } | null} */
let cachedClient = null;

/**
 * GitHub client. Without overrides, returns one shared instance per token so
 * per-process caches (e.g. the authenticated user) survive across tool calls.
 */
function createGithubClient(overrides = {}) {
  const token = overrides.token || requireEnv('GITHUB_TOKEN');
  const baseUrl = (
    overrides.baseUrl ||
    process.env.GITHUB_API_BASE_URL ||
    'https://api.github.com'
  ).replace(/\/$/, '');
  const useCache = !overrides.token && !overrides.baseUrl;
  const cacheKey = `${baseUrl}|${token}`;
  if (useCache && cachedClient?.key === cacheKey) return cachedClient.client;

  const client = buildGithubClient({ token, baseUrl });
  if (useCache) cachedClient = { key: cacheKey, client };
  return client;
}

function buildGithubClient({ token, baseUrl }) {
  /** @type {Promise<object> | null} */
  let userPromise = null;
  const repoPath = (owner, repo) =>
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function requestOnce(method, path, body) {
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
        const rateLimited = isRateLimited(response.status, data);
        const detail =
          (data && typeof data === 'object' && (data.message || data.error)) ||
          (typeof data === 'string' ? data : response.statusText);
        let message = `GitHub ${method} ${path} failed (${response.status}): ${detail}`;
        if ((response.status === 401 || response.status === 403) && !rateLimited) {
          message += ' — check GITHUB_TOKEN in .env (scopes: repo for private, public_repo for public)';
        }
        timer.end(`status=${response.status} bytes=${text.length}`);
        throw new GithubError(message, response.status, data, {
          rateLimited,
          retryAfterMs: rateLimited ? retryDelayMs(response, data, 0) : null,
        });
      }

      const exhausted = resetWaitMs(response.headers);
      if (exhausted > 0) {
        console.error(
          `[github] primary rate limit exhausted, waiting ${Math.ceil(exhausted / 1000)}s before continuing`
        );
        await sleep(exhausted);
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

  async function request(method, path, body) {
    const limit = limiterFor(path);
    for (let attempt = 0; attempt < RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      await waitForCooldown();
      try {
        return await limit(() => requestOnce(method, path, body));
      } catch (err) {
        const retryable = err instanceof GithubError && err.rateLimited;
        if (!retryable || attempt >= RATE_LIMIT_MAX_ATTEMPTS - 1) throw err;
        const wait = Math.max(
          err.retryAfterMs || 0,
          Math.min(
            SECONDARY_RATE_LIMIT_FLOOR_MS * 2 ** attempt,
            RATE_LIMIT_CAP_MS
          )
        );
        cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
        console.error(
          `[github] rate limited on ${method} ${path}; waiting ${Math.ceil(wait / 1000)}s ` +
            `(retry ${attempt + 1}/${RATE_LIMIT_MAX_ATTEMPTS - 1})`
        );
        await sleep(wait);
      }
    }
  }

  return {
    baseUrl,

    /** Authenticated user; cached for the life of this client (failures are not cached). */
    async getAuthenticatedUser() {
      if (!userPromise) {
        userPromise = request('GET', '/user').catch((err) => {
          userPromise = null;
          throw err;
        });
      }
      return userPromise;
    },

    /** Orgs the auth user belongs to (needs read:org for private memberships). */
    async listMyOrgs({ per_page = 100 } = {}) {
      return request('GET', `/user/orgs?per_page=${per_page}`);
    },

    async getRepo({ owner, repo } = {}) {
      return request('GET', repoPath(owner, repo));
    },

    /**
     * File or directory contents at a ref (default branch when ref is omitted).
     * @param {{ owner: string, repo: string, path?: string, ref?: string }} opts
     */
    async getContent({ owner, repo, path = '', ref } = {}) {
      const cleaned = String(path || '')
        .replace(/^\/+/, '')
        .split('/')
        .map(encodeURIComponent)
        .join('/');
      const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      return request('GET', `${repoPath(owner, repo)}/contents/${cleaned}${qs}`);
    },

    /** README at a ref (default branch when ref is omitted). */
    async getReadme({ owner, repo, ref } = {}) {
      const qs = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      return request('GET', `${repoPath(owner, repo)}/readme${qs}`);
    },

    async listPullReviews({ owner, repo, number, per_page = 50 } = {}) {
      return request(
        'GET',
        `${repoPath(owner, repo)}/pulls/${encodeURIComponent(number)}/reviews?per_page=${per_page}`
      );
    },

    /** Issue or PR conversation comments (not inline review comments). */
    async listIssueComments({ owner, repo, number, per_page = 30 } = {}) {
      return request(
        'GET',
        `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}/comments?per_page=${per_page}`
      );
    },

    async getIssue({ owner, repo, number } = {}) {
      return request('GET', `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}`);
    },

    /** Comment on an issue or PR conversation. */
    async createIssueComment({ owner, repo, number, body } = {}) {
      return request('POST', `${repoPath(owner, repo)}/issues/${encodeURIComponent(number)}/comments`, {
        body: String(body || ''),
      });
    },

    /**
     * @param {{ owner: string, repo: string, title: string, body?: string, labels?: string[], assignees?: string[] }} opts
     */
    async createIssue({ owner, repo, title, body, labels, assignees } = {}) {
      const payload = { title: String(title || '') };
      if (body) payload.body = String(body);
      if (labels?.length) payload.labels = labels;
      if (assignees?.length) payload.assignees = assignees;
      return request('POST', `${repoPath(owner, repo)}/issues`, payload);
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
  isGithubConfigured,
  GithubError,
  parseRepo,
  parseGithubUrl,
};
