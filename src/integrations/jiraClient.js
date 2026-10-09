class JiraError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'JiraError';
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
const { sleep, createLimiter, parseRetryAfterMs } = require('../util/rateLimiter');

const RETRY_STATUSES = new Set([429, 503]);
const MAX_ATTEMPTS = 4;
const RETRY_CAP_MS = 60_000;

/** Shared across clients — Jira Cloud rate-limits per user/token. */
const jiraLimiter = createLimiter({ maxConcurrent: 4, minIntervalMs: 50 });

/** @type {{ key: string, client: object } | null} */
let cachedClient = null;


/**
 * Convert markdown-ish plain text into Jira ADF.
 * Supports paragraphs, hard breaks, headings, bullets, bold, italic, inline code, links.
 */
function toAdf(markdown) {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  if (!text.trim()) {
    return { type: 'doc', version: 1, content: [] };
  }

  const blocks = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        attrs: { level: Math.min(headingMatch[1].length, 6) },
        content: inlineNodes(headingMatch[2]),
      });
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const itemText = lines[i].replace(/^\s*[-*]\s+/, '');
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: inlineNodes(itemText) }],
        });
        i += 1;
      }
      blocks.push({ type: 'bulletList', content: items });
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }

    const content = [];
    paraLines.forEach((paraLine, idx) => {
      content.push(...inlineNodes(paraLine));
      if (idx < paraLines.length - 1) {
        content.push({ type: 'hardBreak' });
      }
    });
    blocks.push({ type: 'paragraph', content: content.length ? content : [] });
  }

  return {
    type: 'doc',
    version: 1,
    content: blocks.length ? blocks : [{ type: 'paragraph', content: [] }],
  };
}

function inlineNodes(text) {
  const nodes = [];
  const re =
    /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push({ type: 'text', text: text.slice(last, match.index) });
    }
    if (match[2] !== undefined) {
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'strong' }] });
    } else if (match[3] !== undefined) {
      nodes.push({ type: 'text', text: match[3], marks: [{ type: 'em' }] });
    } else if (match[4] !== undefined) {
      nodes.push({ type: 'text', text: match[4], marks: [{ type: 'code' }] });
    } else if (match[5] !== undefined) {
      nodes.push({
        type: 'text',
        text: match[5],
        marks: [{ type: 'link', attrs: { href: match[6] } }],
      });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    nodes.push({ type: 'text', text: text.slice(last) });
  }
  if (!nodes.length) {
    nodes.push({ type: 'text', text: text || '' });
  }
  return nodes;
}

/** Flatten ADF (or string) to plain text for display. */
function adfToPlainText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToPlainText).join('');
  if (typeof node !== 'object') return String(node);

  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return `@${node.attrs?.text || node.attrs?.id || 'user'}`;

  const kids = node.content ? adfToPlainText(node.content) : '';
  if (node.type === 'paragraph' || node.type === 'heading') return kids ? `${kids}\n` : '';
  if (node.type === 'listItem') return `- ${kids.trim()}\n`;
  return kids;
}

function isJiraConfigured() {
  return Boolean(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
}

/**
 * Jira client. Without overrides, returns one shared instance per env config
 * so per-process caches (e.g. getMyself) survive across tool calls.
 */
function createJiraClient(overrides = {}) {
  const baseUrl = (overrides.baseUrl || requireEnv('JIRA_BASE_URL')).replace(/\/$/, '');
  const email = overrides.email || requireEnv('JIRA_EMAIL');
  const apiToken = overrides.apiToken || requireEnv('JIRA_API_TOKEN');
  const useCache = !overrides.baseUrl && !overrides.email && !overrides.apiToken;
  const cacheKey = `${baseUrl}|${email}|${apiToken}`;
  if (useCache && cachedClient?.key === cacheKey) return cachedClient.client;

  const client = buildJiraClient({ baseUrl, email, apiToken });
  if (useCache) cachedClient = { key: cacheKey, client };
  return client;
}

function buildJiraClient({ baseUrl, email, apiToken }) {
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  /** @type {Promise<object> | null} */
  let myselfPromise = null;

  async function request(method, path, body) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await jiraLimiter(() => requestOnce(method, path, body));
      } catch (err) {
        const retryable = err instanceof JiraError && RETRY_STATUSES.has(err.status);
        if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
        const wait = Math.min(err.retryAfterMs || 1000 * 2 ** attempt, RETRY_CAP_MS);
        console.error(
          `[jira] ${err.status} on ${method} ${path}; retrying in ${Math.ceil(wait / 1000)}s (${attempt}/${MAX_ATTEMPTS - 1})`
        );
        await sleep(wait);
      }
    }
  }

  async function requestOnce(method, path, body) {
    const url = `${baseUrl}${path}`;
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const timer = startTimer(`jira.${method} ${path}`);
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
          (data &&
            typeof data === 'object' &&
            (data.errorMessages?.join('; ') ||
              (data.errors && Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join('; ')) ||
              data.message)) ||
          (typeof data === 'string' ? data : response.statusText);
        let message = `Jira ${method} ${path} failed (${response.status}): ${detail}`;
        if (response.status === 401 || response.status === 403) {
          message +=
            ` — check JIRA_EMAIL and JIRA_API_TOKEN in .env (auth email is "${email}", base "${baseUrl}")`;
        }
        timer.end(`status=${response.status} bytes=${text.length}`);
        const error = new JiraError(message, response.status, data);
        error.retryAfterMs = parseRetryAfterMs(response.headers);
        throw error;
      }

      timer.end(`status=${response.status} bytes=${text.length}`);
      return data;
    } catch (err) {
      if (!(err instanceof JiraError)) {
        timer.end('FAILED network/parse');
      }
      throw err;
    }
  }

  return {
    baseUrl,
    email,

    /** Authenticated user; cached for the life of this client (failures are not cached). */
    async getMyself() {
      if (!myselfPromise) {
        myselfPromise = request('GET', '/rest/api/3/myself').catch((err) => {
          myselfPromise = null;
          throw err;
        });
      }
      return myselfPromise;
    },

    /**
     * Find users by name or email fragment.
     * @param {string} query
     * @param {{ maxResults?: number }} [opts]
     */
    async findUsers(query, { maxResults = 10 } = {}) {
      const params = new URLSearchParams({ query: String(query || ''), maxResults: String(maxResults) });
      const data = await request('GET', `/rest/api/3/user/search?${params}`);
      return Array.isArray(data) ? data : [];
    },

    /**
     * Assign an issue; pass null to unassign.
     * @param {string} issueKey
     * @param {string|null} accountId
     */
    async assignIssue(issueKey, accountId) {
      await request('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, {
        accountId: accountId || null,
      });
    },

    /**
     * Log work on an issue.
     * @param {string} issueKey
     * @param {{ timeSpent: string, started?: string, comment?: string }} worklog
     *   timeSpent uses Jira duration syntax ("1h 30m"); started is ISO 8601.
     */
    async addWorklog(issueKey, { timeSpent, started, comment } = {}) {
      const body = { timeSpent: String(timeSpent) };
      if (started) body.started = toJiraTimestamp(started);
      if (comment) body.comment = toAdf(comment);
      return request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog`, body);
    },

    /**
     * Projects visible to the auth user.
     * @param {{ query?: string, maxResults?: number }} [opts]
     */
    async searchProjects({ query, maxResults = 50 } = {}) {
      const params = new URLSearchParams({ maxResults: String(maxResults), orderBy: 'name' });
      if (query) params.set('query', query);
      const data = await request('GET', `/rest/api/3/project/search?${params}`);
      return data.values || [];
    },

    /** Issue types that can be created in a project. */
    async getCreatableIssueTypes(projectKey) {
      const data = await request(
        'GET',
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes?maxResults=50`
      );
      return data.issueTypes || data.values || [];
    },

    async getIssue(issueKey, { fields } = {}) {
      const params = new URLSearchParams();
      if (fields?.length) {
        params.set('fields', fields.join(','));
      }
      const qs = params.toString();
      const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}${qs ? `?${qs}` : ''}`;
      return request('GET', path);
    },

    async getTransitions(issueKey) {
      const data = await request(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
      );
      return data.transitions || [];
    },

    async transitionIssue(issueKey, transitionId) {
      await request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
        transition: { id: String(transitionId) },
      });
    },

    async addComment(issueKey, body) {
      return request('POST', `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
        body: toAdf(body),
      });
    },

    /**
     * @param {string} issueKey
     * @param {{ maxResults?: number, orderBy?: string }} [opts]
     */
    async getComments(issueKey, { maxResults = 50, orderBy = 'created' } = {}) {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        orderBy,
      });
      const data = await request(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?${params}`
      );
      return {
        comments: data.comments || [],
        total: data.total ?? (data.comments || []).length,
        raw: data,
      };
    },

    async deleteComment(issueKey, commentId) {
      await request(
        'DELETE',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`
      );
      return { deleted: true, commentId: String(commentId) };
    },

    /**
     * Update issue fields (description as markdown).
     * @param {string} issueKey
     * @param {{ description?: string, summary?: string, priority?: string, addLabels?: string[], removeLabels?: string[] }} changes
     */
    async updateIssue(issueKey, { description, summary, priority, addLabels, removeLabels } = {}) {
      const fields = {};
      const update = {};
      if (description !== undefined) {
        fields.description = toAdf(description);
      }
      if (summary !== undefined) {
        fields.summary = summary;
      }
      if (priority) {
        fields.priority = { name: String(priority) };
      }
      const labelOps = [
        ...(addLabels || []).map((l) => ({ add: l })),
        ...(removeLabels || []).map((l) => ({ remove: l })),
      ];
      if (labelOps.length) update.labels = labelOps;
      if (!Object.keys(fields).length && !Object.keys(update).length) {
        throw new Error('updateIssue requires at least one field');
      }
      const body = {};
      if (Object.keys(fields).length) body.fields = fields;
      if (Object.keys(update).length) body.update = update;
      await request('PUT', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, body);
      return { updated: true };
    },

    /**
     * Search issues via JQL (enhanced search endpoint).
     * @param {{ jql: string, maxResults?: number, fields?: string[], nextPageToken?: string }} opts
     */
    async searchIssues({ jql, maxResults = 50, fields, nextPageToken } = {}) {
      const body = {
        jql,
        maxResults,
        fields: fields || ['summary', 'status', 'priority', 'issuetype', 'updated', 'assignee'],
      };
      if (nextPageToken) {
        body.nextPageToken = nextPageToken;
      }
      const data = await request('POST', '/rest/api/3/search/jql', body);
      return {
        issues: data.issues || [],
        isLast: data.isLast,
        nextPageToken: data.nextPageToken,
        raw: data,
      };
    },

    /**
     * Paginated issue changelog.
     * @param {string} issueKey
     * @param {{ maxResults?: number, startAt?: number }} [opts]
     */
    async getChangelog(issueKey, { maxResults = 100, startAt = 0 } = {}) {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt),
      });
      const data = await request(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?${params}`
      );
      return {
        values: data.values || [],
        startAt: data.startAt ?? startAt,
        maxResults: data.maxResults ?? maxResults,
        total: data.total ?? (data.values || []).length,
        isLast: data.isLast,
        raw: data,
      };
    },

    /**
     * Paginated worklogs for an issue.
     * @param {string} issueKey
     * @param {{ maxResults?: number, startAt?: number }} [opts]
     */
    async getWorklogs(issueKey, { maxResults = 100, startAt = 0 } = {}) {
      const params = new URLSearchParams({
        maxResults: String(maxResults),
        startAt: String(startAt),
      });
      const data = await request(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(issueKey)}/worklog?${params}`
      );
      return {
        worklogs: data.worklogs || [],
        startAt: data.startAt ?? startAt,
        maxResults: data.maxResults ?? maxResults,
        total: data.total ?? (data.worklogs || []).length,
        raw: data,
      };
    },

    /**
     * Create a Jira issue.
     * @param {{ projectKey: string, summary: string, issueType?: string, description?: string, assigneeAccountId?: string, parentKey?: string, labels?: string[], priority?: string, components?: string[] }} fields
     */
    async createIssue({
      projectKey,
      summary,
      issueType = 'Task',
      description,
      assigneeAccountId,
      parentKey,
      labels,
      priority,
      components,
    }) {
      const fields = {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueType },
      };
      if (description) {
        fields.description = toAdf(description);
      }
      if (assigneeAccountId) {
        fields.assignee = { id: assigneeAccountId };
      }
      if (parentKey) {
        fields.parent = { key: String(parentKey).trim().toUpperCase() };
      }
      if (labels?.length) {
        fields.labels = labels;
      }
      if (priority) {
        fields.priority = { name: String(priority) };
      }
      if (components?.length) {
        fields.components = components.map((name) => ({ name }));
      }
      return request('POST', '/rest/api/3/issue', { fields });
    },

    /**
     * Create a directional issue link.
     * Jira semantics: inwardIssue is linked "from", outwardIssue is linked "to"
     * for types like Relates (symmetric) or Blocks.
     * @param {{ inwardKey: string, outwardKey: string, type?: string }} opts
     */
    async createIssueLink({ inwardKey, outwardKey, type = 'Relates' } = {}) {
      const inward = String(inwardKey || '').trim().toUpperCase();
      const outward = String(outwardKey || '').trim().toUpperCase();
      if (!inward || !outward) {
        throw new Error('createIssueLink requires inwardKey and outwardKey');
      }
      return request('POST', '/rest/api/3/issueLink', {
        type: { name: String(type || 'Relates') },
        inwardIssue: { key: inward },
        outwardIssue: { key: outward },
      });
    },
  };
}

/** Jira wants "2026-10-09T09:00:00.000+0000" — no colon in the offset. */
function toJiraTimestamp(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid start time: ${value}`);
  return d.toISOString().replace('Z', '+0000');
}

/**
 * Canonical browse link — never invent domains; always use JIRA_BASE_URL.
 * @param {string} baseUrl
 * @param {string} issueKey
 */
function browseUrl(baseUrl, issueKey) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const key = String(issueKey || '').trim().toUpperCase();
  if (!base || !key) return null;
  return `${base}/browse/${key}`;
}

module.exports = {
  createJiraClient,
  isJiraConfigured,
  JiraError,
  toAdf,
  adfToPlainText,
  browseUrl,
  toJiraTimestamp,
};
