const { createJiraClient } = require('../integrations/jiraClient');

const DEFAULT_MAX = 25;
const HARD_MAX = 50;

function log(...args) {
  console.error('[jira-my-issues]', ...args);
}

function escapeJqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a text search clause. Multi-word queries become OR of tokens
 * because Jira phrase match on "allocation and scheduling" is too strict.
 */
function buildTextClause(query) {
  const stop = new Set(['and', 'or', 'the', 'a', 'an', 'for', 'to', 'of', 'in', 'on', 'my', 'me', 'related']);
  const words = String(query)
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !stop.has(w.toLowerCase()));

  const terms = words.length ? words : [String(query).trim()].filter(Boolean);
  if (!terms.length) return null;

  const parts = terms.map((w) => {
    const q = escapeJqlString(w);
    return `(summary ~ "${q}" OR text ~ "${q}")`;
  });
  return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
}

/**
 * Parse types from string ("Story,Epic") or array.
 * @param {string|string[]|undefined} raw
 * @returns {string[]}
 */
function parseTypes(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean);
  }
  return String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Normalize resolution filter: unresolved (default) | resolved | all.
 * @param {unknown} raw
 * @returns {'unresolved'|'resolved'|'all'}
 */
function parseResolution(raw) {
  const v = String(raw ?? 'unresolved').trim().toLowerCase();
  if (v === 'resolved' || v === 'done' || v === 'closed') return 'resolved';
  if (v === 'all' || v === 'any' || v === 'both') return 'all';
  // booleans / includeResolved aliases
  if (raw === true || v === 'true' || v === 'include') return 'all';
  return 'unresolved';
}

/**
 * List Jira issues assigned to the authenticated user.
 * Defaults to unresolved; pass resolution=resolved|all for closed work.
 * @param {{ max?: number|string, status?: string, query?: string, types?: string|string[], resolution?: string|boolean, autoBroaden?: boolean, verbose?: boolean }} payload
 */
async function jiraMyIssuesTask(payload = {}) {
  let max = Number(payload.max);
  if (!Number.isFinite(max) || max <= 0) max = DEFAULT_MAX;
  max = Math.min(Math.floor(max), HARD_MAX);

  const statusFilter = payload.status?.trim() || '';
  let query = (payload.query || payload.text || '').trim();
  let types = parseTypes(payload.types ?? payload.type);
  const resolution = parseResolution(payload.resolution ?? payload.includeResolved);
  const autoBroaden = payload.autoBroaden !== false;

  const jira = createJiraClient();

  log(`baseUrl=${jira.baseUrl}`);
  log(`authEmail=${jira.email}`);

  const myself = await jira.getMyself();
  const profile = {
    accountId: myself.accountId || null,
    displayName: myself.displayName || null,
    emailAddress: myself.emailAddress || null,
    active: myself.active,
    timeZone: myself.timeZone || null,
  };
  log(
    `connected as displayName="${profile.displayName}" email="${profile.emailAddress}" accountId=${profile.accountId} active=${profile.active}`
  );

  /** @type {string[]} */
  const broadenNotes = [];

  async function runSearch(q, t, res = resolution) {
    const clauses = ['assignee = currentUser()'];
    if (res === 'unresolved') {
      clauses.push('resolution = Unresolved');
    } else if (res === 'resolved') {
      clauses.push('resolution != Unresolved');
    }
    if (statusFilter) {
      clauses.push(`status = "${escapeJqlString(statusFilter)}"`);
    }
    if (t.length) {
      const list = t.map((x) => `"${escapeJqlString(x)}"`).join(', ');
      clauses.push(`issuetype in (${list})`);
    }
    if (q) {
      // Exact key → never fuzzy text search (avoids EVP2-* false hits mentioning the key)
      const keyMatch = String(q).trim().match(/^([A-Z][A-Z0-9]+-\d+)$/i);
      if (keyMatch) {
        clauses.push(`key = "${escapeJqlString(keyMatch[1].toUpperCase())}"`);
      } else {
        const textClause = buildTextClause(q);
        if (textClause) clauses.push(textClause);
      }
    }
    const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;
    log(`jql=${jql}`);
    log(`maxResults=${max}`);
    const search = await jira.searchIssues({ jql, maxResults: max });
    log(`search returned issues=${search.issues.length} isLast=${search.isLast}`);
    return { jql, search };
  }

  let { jql, search } = await runSearch(query, types);

  // Progressive broaden so the user does not have to steer "try without Story/Epic".
  if (autoBroaden && search.issues.length === 0 && types.length) {
    broadenNotes.push('Dropped issue-type filter after 0 matches.');
    types = [];
    ({ jql, search } = await runSearch(query, types));
  }

  if (autoBroaden && search.issues.length === 0 && query) {
    const firstWord = query.split(/\s+/).find((w) => w.length > 2);
    if (firstWord && firstWord.toLowerCase() !== query.toLowerCase()) {
      broadenNotes.push(`Simplified query to "${firstWord}" after 0 matches.`);
      query = firstWord;
      ({ jql, search } = await runSearch(query, types));
    }
  }

  if (autoBroaden && search.issues.length === 0 && (query || statusFilter)) {
    const scope =
      resolution === 'resolved'
        ? 'all resolved assigned issues'
        : resolution === 'all'
          ? 'all assigned issues'
          : 'all open assigned issues';
    broadenNotes.push(`Showing ${scope} after filtered search returned 0.`);
    query = '';
    ({ jql, search } = await runSearch('', []));
  }

  const items = search.issues.map((issue) => ({
    key: issue.key,
    summary: issue.fields?.summary || '(no summary)',
    status: issue.fields?.status?.name || 'Unknown',
    priority: issue.fields?.priority?.name || null,
    type: issue.fields?.issuetype?.name || null,
    assignee: issue.fields?.assignee?.displayName || null,
    browseUrl: `${jira.baseUrl}/browse/${issue.key}`,
  }));

  return {
    count: items.length,
    max,
    statusFilter: statusFilter || null,
    query: query || null,
    types: types.length ? types : null,
    resolution,
    jql,
    broadenNotes,
    connection: {
      baseUrl: jira.baseUrl,
      authEmail: jira.email,
      profile,
    },
    issues: items,
  };
}

function resolutionLabel(resolution) {
  if (resolution === 'resolved') return 'resolved';
  if (resolution === 'all') return 'all';
  return 'unresolved';
}

function formatResult(result) {
  const p = result.connection?.profile || {};
  const connLines = [
    `Jira: ${result.connection?.baseUrl || '?'}`,
    `Auth email (.env): ${result.connection?.authEmail || '?'}`,
    `Connected as: ${p.displayName || '?'} <${p.emailAddress || 'no-email'}> (${p.accountId || 'no-accountId'})`,
    `JQL: ${result.jql}`,
  ];

  const filters = [];
  const res = result.resolution || 'unresolved';
  if (res !== 'unresolved') filters.push(`resolution: ${resolutionLabel(res)}`);
  if (result.statusFilter) filters.push(`status: ${result.statusFilter}`);
  if (result.query) filters.push(`query: ${result.query}`);
  if (result.types?.length) filters.push(`types: ${result.types.join(', ')}`);
  const filterNote = filters.length ? ` (${filters.join('; ')})` : '';

  const broadenLines =
    result.broadenNotes?.length > 0
      ? ['Search auto-broadened:', ...result.broadenNotes.map((n) => `- ${n}`), '']
      : [];

  const emptyNoun =
    res === 'resolved' ? 'resolved issues' : res === 'all' ? 'issues' : 'unresolved issues';

  if (!result.issues.length) {
    return [
      ...connLines,
      '',
      ...broadenLines,
      `No ${emptyNoun} assigned to this account${filterNote}.`,
      'If you expected tickets: confirm the auth email matches your Jira user, and that issues are assigned to that user.',
    ].join('\n');
  }

  const header = `Assigned to you${filterNote}: ${result.count} issue(s)`;
  const lines = result.issues.map((issue) => {
    const pri = issue.priority ? ` · ${issue.priority}` : '';
    const typ = issue.type ? `${issue.type} · ` : '';
    const url = issue.browseUrl ? ` ${issue.browseUrl}` : '';
    return `• ${issue.key} — ${issue.summary} [${typ}${issue.status}${pri}]${url}`;
  });
  return [...connLines, '', ...broadenLines, header, ...lines].join('\n');
}

module.exports = jiraMyIssuesTask;
module.exports.formatResult = formatResult;
module.exports.parseTypes = parseTypes;
module.exports.parseResolution = parseResolution;
module.exports.escapeJqlString = escapeJqlString;
module.exports.buildTextClause = buildTextClause;
