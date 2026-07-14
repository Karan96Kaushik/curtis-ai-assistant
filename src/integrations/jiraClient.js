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

function createJiraClient(overrides = {}) {
  const baseUrl = (overrides.baseUrl || requireEnv('JIRA_BASE_URL')).replace(/\/$/, '');
  const email = overrides.email || requireEnv('JIRA_EMAIL');
  const apiToken = overrides.apiToken || requireEnv('JIRA_API_TOKEN');
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  async function request(method, path, body) {
    const url = `${baseUrl}${path}`;
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

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
        (data && typeof data === 'object' && (data.errorMessages?.join('; ') || data.message)) ||
        (typeof data === 'string' ? data : response.statusText);
      let message = `Jira ${method} ${path} failed (${response.status}): ${detail}`;
      if (response.status === 401 || response.status === 403) {
        message +=
          ` — check JIRA_EMAIL and JIRA_API_TOKEN in .env (auth email is "${email}", base "${baseUrl}")`;
      }
      throw new JiraError(message, response.status, data);
    }

    return data;
  }

  function toAdf(text) {
    return {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: String(text) }],
        },
      ],
    };
  }

  return {
    baseUrl,
    email,

    async getMyself() {
      return request('GET', '/rest/api/3/myself');
    },

    async getIssue(issueKey) {
      return request('GET', `/rest/api/3/issue/${encodeURIComponent(issueKey)}`);
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
     * Search issues via JQL (enhanced search endpoint).
     * @param {{ jql: string, maxResults?: number, fields?: string[] }} opts
     * @returns {Promise<{ issues: object[], isLast?: boolean, nextPageToken?: string, raw: object }>}
     */
    async searchIssues({ jql, maxResults = 50, fields } = {}) {
      const data = await request('POST', '/rest/api/3/search/jql', {
        jql,
        maxResults,
        fields: fields || ['summary', 'status', 'priority', 'issuetype', 'updated', 'assignee'],
      });
      return {
        issues: data.issues || [],
        isLast: data.isLast,
        nextPageToken: data.nextPageToken,
        raw: data,
      };
    },

    /**
     * Create a Jira issue.
     * @param {{ projectKey: string, summary: string, issueType?: string, description?: string, assigneeAccountId?: string }} fields
     */
    async createIssue({
      projectKey,
      summary,
      issueType = 'Task',
      description,
      assigneeAccountId,
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
      return request('POST', '/rest/api/3/issue', { fields });
    },
  };
}

module.exports = { createJiraClient, JiraError };
