/**
 * Small read-only Jira lookups: transitions, users, projects / issue types.
 */

const { createJiraClient, JiraError } = require('../integrations/jiraClient');
const { normalizeIssueKey } = require('../util/jiraKeys');

function envelope(data) {
  return { ok: true, source: 'jira', confidence: 'high', data };
}

/** @param {{ issue: string }} payload */
async function transitions(payload = {}) {
  const issueKey = normalizeIssueKey(payload.issue);
  if (!issueKey) throw new Error('Missing or invalid issue key');
  const jira = createJiraClient();
  try {
    const list = await jira.getTransitions(issueKey);
    return envelope({
      issueKey,
      transitions: list.map((t) => ({ id: t.id, name: t.name, to: t.to?.name || null })),
    });
  } catch (err) {
    if (err instanceof JiraError && err.status === 404) throw new Error(`Issue not found: ${issueKey}`);
    throw err;
  }
}

function formatTransitions(raw) {
  const d = raw.data;
  if (!d.transitions.length) return `${d.issueKey}: no transitions available to you.`;
  return [
    `${d.issueKey}: available transitions (pass the name as jira_update status):`,
    ...d.transitions.map((t) => `• ${t.name}${t.to && t.to !== t.name ? ` → ${t.to}` : ''}`),
  ].join('\n');
}

/** @param {{ query: string, max?: number }} payload */
async function findUser(payload = {}) {
  const query = String(payload.query || '').trim();
  if (!query) throw new Error('Missing required field: query');
  const jira = createJiraClient();
  const users = await jira.findUsers(query, { maxResults: Math.min(Number(payload.max) || 10, 20) });
  return envelope({
    query,
    users: users
      .filter((u) => u.accountType !== 'app')
      .map((u) => ({
        accountId: u.accountId,
        displayName: u.displayName || null,
        email: u.emailAddress || null,
        active: u.active !== false,
      })),
  });
}

function formatFindUser(raw) {
  const d = raw.data;
  if (!d.users.length) return `No Jira users matched "${d.query}".`;
  return [
    `Jira users matching "${d.query}":`,
    ...d.users.map(
      (u) => `• ${u.displayName || '?'}${u.email ? ` <${u.email}>` : ''}${u.active ? '' : ' (inactive)'} — accountId ${u.accountId}`
    ),
  ].join('\n');
}

/** @param {{ query?: string, project?: string }} payload */
async function listProjects(payload = {}) {
  const jira = createJiraClient();
  const projectKey = String(payload.project || '').trim().toUpperCase();
  if (projectKey) {
    const types = await jira.getCreatableIssueTypes(projectKey);
    return envelope({
      project: projectKey,
      issueTypes: types.map((t) => ({ name: t.name, subtask: Boolean(t.subtask) })),
    });
  }
  const projects = await jira.searchProjects({ query: payload.query ? String(payload.query) : undefined });
  return envelope({
    query: payload.query || null,
    projects: projects.map((p) => ({ key: p.key, name: p.name, type: p.projectTypeKey || null })),
  });
}

function formatListProjects(raw) {
  const d = raw.data;
  if (d.project) {
    if (!d.issueTypes.length) return `No creatable issue types found for ${d.project}.`;
    return [
      `Issue types you can create in ${d.project}:`,
      ...d.issueTypes.map((t) => `• ${t.name}${t.subtask ? ' (sub-task — needs parent)' : ''}`),
    ].join('\n');
  }
  if (!d.projects.length) return `No Jira projects matched${d.query ? ` "${d.query}"` : ''}.`;
  return [
    `Jira projects${d.query ? ` matching "${d.query}"` : ''}:`,
    ...d.projects.map((p) => `• ${p.key} — ${p.name}`),
  ].join('\n');
}

module.exports = {
  transitions,
  formatTransitions,
  findUser,
  formatFindUser,
  listProjects,
  formatListProjects,
};
