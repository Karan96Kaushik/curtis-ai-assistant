const { createJiraClient, adfToPlainText, browseUrl } = require('../integrations/jiraClient');
const { resolveMonth } = require('../util/monthRange');

const PAGE_SIZE = 50;
const DEFAULT_MAX_ISSUES = 100;
const HARD_MAX_ISSUES = 300;
const DEFAULT_DETAIL_ISSUES = 80;
const DETAIL_CONCURRENCY = 5;

const FIELDS = [
  'summary',
  'status',
  'priority',
  'issuetype',
  'project',
  'created',
  'updated',
  'resolutiondate',
  'assignee',
  'reporter',
];

function log(...args) {
  console.error('[jira-monthly-activity]', ...args);
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['false', 'no', '0', 'off'].includes(s)) return false;
  if (['true', 'yes', '1', 'on'].includes(s)) return true;
  return fallback;
}

function clampInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function inRange(iso, start, endExclusive) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return (
    t >= Date.parse(`${start}T00:00:00.000Z`) &&
    t < Date.parse(`${endExclusive}T00:00:00.000Z`)
  );
}

function fmtStamp(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function secondsToHours(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '0h';
  return `${Math.round((n / 3600) * 100) / 100}h`;
}

function truncate(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Union of "touched by me during the month" signals.
 */
function buildActivityJql(start, endExclusive) {
  return [
    '(',
    `  (reporter = currentUser() AND created >= "${start}" AND created < "${endExclusive}")`,
    `  OR (updated >= "${start}" AND updated < "${endExclusive}" AND (assignee = currentUser() OR reporter = currentUser()))`,
    `  OR (status changed BY currentUser() DURING ("${start}", "${endExclusive}"))`,
    `  OR (assignee changed BY currentUser() DURING ("${start}", "${endExclusive}"))`,
    ')',
    'ORDER BY updated DESC',
  ].join(' ');
}

async function searchAllIssues(jira, jql, maxIssues) {
  const issues = [];
  let nextPageToken;

  while (issues.length < maxIssues) {
    const page = await jira.searchIssues({
      jql,
      maxResults: Math.min(PAGE_SIZE, maxIssues - issues.length),
      fields: FIELDS,
      nextPageToken,
    });
    issues.push(...page.issues);
    if (page.isLast || !page.nextPageToken || !page.issues.length) break;
    nextPageToken = page.nextPageToken;
  }

  return issues;
}

async function allChangelog(jira, issueKey) {
  const values = [];
  let startAt = 0;
  for (;;) {
    const page = await jira.getChangelog(issueKey, { maxResults: 100, startAt });
    values.push(...page.values);
    if (
      page.isLast === true ||
      !page.values.length ||
      values.length >= (page.total ?? values.length)
    ) {
      break;
    }
    startAt += page.values.length;
  }
  return values;
}

async function allWorklogs(jira, issueKey) {
  const worklogs = [];
  let startAt = 0;
  for (;;) {
    const page = await jira.getWorklogs(issueKey, { maxResults: 100, startAt });
    worklogs.push(...page.worklogs);
    if (!page.worklogs.length || worklogs.length >= (page.total ?? worklogs.length)) break;
    startAt += page.worklogs.length;
  }
  return worklogs;
}

async function collectIssueActivity(jira, issue, accountId, { detail, start, endExclusive }) {
  const f = issue.fields || {};
  const events = [];
  const inMonth = (iso) => inRange(iso, start, endExclusive);

  if (f.reporter?.accountId === accountId && inMonth(f.created)) {
    events.push({ at: f.created, kind: 'created', detail: 'Created issue' });
  }

  if (!detail) {
    if (inMonth(f.updated)) {
      events.push({ at: f.updated, kind: 'updated', detail: 'Issue updated (detail skipped)' });
    }
    return sortAndDedupe(events);
  }

  const [changelog, commentPage, worklogs] = await Promise.all([
    allChangelog(jira, issue.key),
    jira.getComments(issue.key, { maxResults: 100, orderBy: 'created' }),
    allWorklogs(jira, issue.key),
  ]);

  for (const hist of changelog) {
    if (hist.author?.accountId !== accountId || !inMonth(hist.created)) continue;
    const items = (hist.items || []).map((it) => {
      const field = it.field || '?';
      const from = it.fromString ?? it.from ?? '';
      const to = it.toString ?? it.to ?? '';
      if (from || to) return `${field}: ${from || '(empty)'} → ${to || '(empty)'}`;
      return field;
    });
    events.push({
      at: hist.created,
      kind: 'change',
      detail: items.length ? truncate(items.join('; '), 220) : 'Field change',
    });
  }

  for (const c of commentPage.comments || []) {
    if (c.author?.accountId !== accountId || !inMonth(c.created)) continue;
    events.push({ at: c.created, kind: 'comment', detail: truncate(adfToPlainText(c.body)) });
  }

  for (const w of worklogs) {
    const when = w.started || w.created;
    if (w.author?.accountId !== accountId || !inMonth(when)) continue;
    const note = w.comment ? adfToPlainText(w.comment) : w.timeSpent || '';
    events.push({
      at: when,
      kind: 'worklog',
      detail: `${secondsToHours(w.timeSpentSeconds)} — ${truncate(note, 120)}`,
    });
  }

  return sortAndDedupe(events);
}

function sortAndDedupe(events) {
  const seen = new Set();
  const out = [];
  for (const e of events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const sig = `${e.at}|${e.kind}|${e.detail}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(e);
  }
  return out;
}

/** Bounded-concurrency map that preserves input order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function summarizeIssue(issue, jiraBase, events) {
  const f = issue.fields || {};
  return {
    key: issue.key,
    summary: f.summary || '(no summary)',
    type: f.issuetype?.name || null,
    status: f.status?.name || null,
    priority: f.priority?.name || null,
    project: f.project?.key || null,
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    created: f.created || null,
    updated: f.updated || null,
    resolved: f.resolutiondate || null,
    browseUrl: browseUrl(jiraBase, issue.key),
    activityCount: events.length,
    activity: events,
  };
}

/**
 * Jira activity report for one calendar month.
 *
 * @param {{
 *   month?: string|number,
 *   year?: string|number,
 *   text?: string,
 *   detail?: boolean|string,
 *   maxIssues?: number|string,
 *   maxDetailIssues?: number|string,
 * }} [payload]
 */
async function jiraMonthlyActivityTask(payload = {}) {
  const period = resolveMonth({
    month: payload.month,
    year: payload.year,
    text: payload.text,
  });
  const detail = toBool(payload.detail, true);
  const maxIssues = clampInt(payload.maxIssues ?? payload.max, DEFAULT_MAX_ISSUES, HARD_MAX_ISSUES);
  const maxDetailIssues = clampInt(
    payload.maxDetailIssues,
    DEFAULT_DETAIL_ISSUES,
    HARD_MAX_ISSUES
  );

  const jira = createJiraClient();
  const myself = await jira.getMyself();
  const accountId = myself.accountId;
  if (!accountId) throw new Error('Jira /myself did not return accountId');

  const jql = buildActivityJql(period.start, period.endExclusive);
  log(`${period.label} as ${myself.displayName} (${accountId}) detail=${detail}`);
  log(`jql=${jql}`);

  const rawIssues = await searchAllIssues(jira, jql, maxIssues);
  log(`matched issues=${rawIssues.length}`);

  const detailCount = detail ? Math.min(rawIssues.length, maxDetailIssues) : 0;
  const eventLists = await mapWithConcurrency(rawIssues, DETAIL_CONCURRENCY, (issue, i) =>
    collectIssueActivity(jira, issue, accountId, {
      detail: i < detailCount,
      start: period.start,
      endExclusive: period.endExclusive,
    })
  );

  const byKind = {};
  let eventCount = 0;
  const issues = rawIssues.map((issue, i) => {
    const events = eventLists[i] || [];
    eventCount += events.length;
    for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    return summarizeIssue(issue, jira.baseUrl, events);
  });

  issues.sort((a, b) => {
    if (b.activityCount !== a.activityCount) return b.activityCount - a.activityCount;
    return Date.parse(b.updated || 0) - Date.parse(a.updated || 0);
  });

  return {
    reportType: 'jira-monthly-activity',
    month: period.label,
    slug: period.slug,
    range: { start: period.start, end: period.end, endExclusive: period.endExclusive },
    monthDefaulted: Boolean(period.defaulted),
    baseUrl: jira.baseUrl,
    authEmail: jira.email,
    profile: {
      accountId,
      displayName: myself.displayName || null,
      emailAddress: myself.emailAddress || null,
      timeZone: myself.timeZone || null,
    },
    jql,
    detail,
    detailIssueCount: detailCount,
    detailTruncated: detail && rawIssues.length > detailCount,
    issueCount: issues.length,
    issueLimitHit: rawIssues.length >= maxIssues,
    eventCount,
    stats: { byKind },
    issues,
    generatedAt: new Date().toISOString(),
  };
}

function kindSummaryLine(byKind) {
  const parts = Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${n} ${kind}`);
  return parts.length ? parts.join(', ') : 'no authored events';
}

/** Compact chat-friendly summary. */
function formatResult(result, { maxIssues = 20 } = {}) {
  const lines = [
    `Jira activity — ${result.month} (${result.profile?.displayName || 'you'})`,
    `${result.issueCount} issue(s) touched · ${result.eventCount} event(s): ${kindSummaryLine(result.stats?.byKind || {})}`,
  ];

  if (!result.issueCount) {
    lines.push(`No Jira activity found for ${result.month}.`);
    return lines.join('\n');
  }

  lines.push('');
  for (const issue of result.issues.slice(0, maxIssues)) {
    const n = issue.activityCount;
    const count = n ? ` — ${n} event${n === 1 ? '' : 's'}` : '';
    lines.push(
      `• ${issue.key} — ${issue.summary} [${issue.status || '?'}]${count}\n  ${issue.browseUrl || ''}`
    );
  }
  if (result.issues.length > maxIssues) {
    lines.push(`…and ${result.issues.length - maxIssues} more issue(s).`);
  }
  if (result.detailTruncated) {
    lines.push(
      `(Timeline detail limited to the ${result.detailIssueCount} most recently updated issues.)`
    );
  }
  return lines.join('\n');
}

/** Full dated timeline per issue — used by the CLI/script report. */
function formatFullReport(result) {
  const p = result.profile || {};
  const lines = [
    `Jira activity — ${result.month}`,
    `Jira: ${result.baseUrl}`,
    `User: ${p.displayName || '?'} <${p.emailAddress || 'no-email'}> (${p.accountId || 'no-accountId'})`,
    `Range: ${result.range.start}..${result.range.end}`,
    `JQL: ${result.jql}`,
    `Issues matched: ${result.issueCount}${result.issueLimitHit ? ' (limit reached)' : ''}`,
    `Activity events: ${result.eventCount}`,
    `Detail: ${result.detail ? 'changelog + comments + worklogs' : 'issue list only'}${result.detailTruncated ? ` (first ${result.detailIssueCount} issues)` : ''}`,
    '',
  ];

  if (!result.issues.length) {
    lines.push(`No activity found for ${result.month}.`);
    return lines.join('\n');
  }

  lines.push('Summary by kind:');
  for (const [kind, n] of Object.entries(result.stats.byKind).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind}: ${n}`);
  }
  lines.push('');

  for (const issue of result.issues) {
    const typ = issue.type ? `${issue.type} · ` : '';
    const pri = issue.priority ? ` · ${issue.priority}` : '';
    lines.push(`── ${issue.key} — ${issue.summary} [${typ}${issue.status || '?'}${pri}]`);
    lines.push(`   ${issue.browseUrl || ''}`);
    lines.push(
      `   project=${issue.project || '?'} assignee=${issue.assignee || 'Unassigned'} reporter=${issue.reporter || '?'}`
    );
    if (!issue.activity.length) {
      lines.push('   (no authored events in month — matched via assignee/reporter/updated window)');
    } else {
      for (const e of issue.activity) {
        lines.push(`   ${fmtStamp(e.at)}  [${e.kind}]  ${e.detail}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

module.exports = jiraMonthlyActivityTask;
module.exports.formatResult = formatResult;
module.exports.formatFullReport = formatFullReport;
module.exports.buildActivityJql = buildActivityJql;
