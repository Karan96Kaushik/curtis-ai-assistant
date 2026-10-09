const { createJiraClient, JiraError, browseUrl } = require('../integrations/jiraClient');
const { parseList } = require('../util/parseList');

/**
 * Pick a transition by name: exact transition name, then exact target status,
 * then a unique partial match on either.
 * @param {{ id: string, name?: string, to?: { name?: string } }[]} transitions
 * @param {string} wanted
 */
function matchTransition(transitions, wanted) {
  const w = wanted.toLowerCase();
  const byName = transitions.find((t) => t.name?.toLowerCase() === w);
  if (byName) return byName;
  const byTarget = transitions.find((t) => t.to?.name?.toLowerCase() === w);
  if (byTarget) return byTarget;
  const partial = transitions.filter(
    (t) => t.name?.toLowerCase().includes(w) || t.to?.name?.toLowerCase().includes(w)
  );
  return partial.length === 1 ? partial[0] : null;
}

/**
 * Resolve "me" / "unassigned" / a name or email to an accountId (null = unassign).
 * @param {ReturnType<typeof createJiraClient>} jira
 * @param {string} assignee
 * @returns {Promise<{ accountId: string|null, label: string }>}
 */
async function resolveAssignee(jira, assignee) {
  const a = assignee.trim();
  if (/^(me|myself|self)$/i.test(a)) {
    const me = await jira.getMyself();
    return { accountId: me.accountId, label: me.displayName || 'you' };
  }
  if (/^(none|nobody|unassign(ed)?)$/i.test(a)) {
    return { accountId: null, label: 'Unassigned' };
  }
  const users = (await jira.findUsers(a, { maxResults: 10 })).filter(
    (u) => u.active !== false && u.accountType !== 'app'
  );
  const lower = a.toLowerCase();
  const exact = users.filter(
    (u) => u.displayName?.toLowerCase() === lower || u.emailAddress?.toLowerCase() === lower
  );
  const pick = exact.length === 1 ? exact[0] : users.length === 1 ? users[0] : null;
  if (!pick) {
    const names = users.map((u) => u.displayName).filter(Boolean);
    throw new Error(
      names.length
        ? `Assignee "${a}" is ambiguous: ${names.join(', ')}. Use the full name or email.`
        : `No active Jira user matched "${a}".`
    );
  }
  return { accountId: pick.accountId, label: pick.displayName || a };
}

/**
 * Update a Jira issue: status, comment, description (markdown), summary,
 * assignee, priority, and labels.
 * @param {{
 *   issue: string, status?: string, comment?: string, description?: string,
 *   summary?: string, assignee?: string, priority?: string,
 *   add_labels?: string|string[], remove_labels?: string|string[]
 * }} payload
 */
async function jiraUpdateTask(payload) {
  const issue = payload?.issue?.trim();
  const status = payload?.status?.trim() || undefined;
  const comment = payload?.comment?.trim() || undefined;
  const description =
    payload?.description !== undefined && payload?.description !== null
      ? String(payload.description)
      : undefined;
  const summary = payload?.summary?.trim() || undefined;
  const assignee = payload?.assignee != null ? String(payload.assignee).trim() : '';
  const priority = payload?.priority?.trim() || undefined;
  const addLabels = parseList(payload?.add_labels);
  const removeLabels = parseList(payload?.remove_labels);

  if (!issue) {
    throw new Error('Missing required field: issue');
  }
  if (
    !status &&
    !comment &&
    description === undefined &&
    !summary &&
    !assignee &&
    !priority &&
    !addLabels.length &&
    !removeLabels.length
  ) {
    throw new Error(
      'Provide at least one of: status, comment, description, summary, assignee, priority, add_labels, remove_labels'
    );
  }

  const jira = createJiraClient();

  let issueKey;
  try {
    const issueData = await jira.getIssue(issue, { fields: ['summary'] });
    issueKey = issueData.key || issue;
  } catch (err) {
    if (err instanceof JiraError && err.status === 404) {
      throw new Error(`Issue not found: ${issue}`);
    }
    throw err;
  }

  const result = {
    issueKey,
    browseUrl: browseUrl(jira.baseUrl, issueKey),
    transitionedTo: null,
    commentAdded: false,
    descriptionUpdated: false,
    summaryUpdated: false,
    assignedTo: null,
    priority: null,
    labelsAdded: [],
    labelsRemoved: [],
  };

  // Resolve before writing anything so a bad assignee or status fails cleanly.
  const assigneeTarget = assignee ? await resolveAssignee(jira, assignee) : null;
  let transition = null;
  if (status) {
    const transitions = await jira.getTransitions(issueKey);
    transition = matchTransition(transitions, status);
    if (!transition) {
      const available = transitions.map((t) => t.name).filter(Boolean);
      const list = available.length ? available.join(', ') : '(none available)';
      throw new Error(`No transition named "${status}" for ${issueKey}. Available: ${list}`);
    }
  }

  if (description !== undefined || summary || priority || addLabels.length || removeLabels.length) {
    await jira.updateIssue(issueKey, { description, summary, priority, addLabels, removeLabels });
    result.descriptionUpdated = description !== undefined;
    result.summaryUpdated = Boolean(summary);
    result.priority = priority || null;
    result.labelsAdded = addLabels;
    result.labelsRemoved = removeLabels;
  }

  if (assigneeTarget) {
    await jira.assignIssue(issueKey, assigneeTarget.accountId);
    result.assignedTo = assigneeTarget.label;
  }

  if (transition) {
    await jira.transitionIssue(issueKey, transition.id);
    result.transitionedTo = transition.to?.name || transition.name;
  }

  if (comment) {
    await jira.addComment(issueKey, comment);
    result.commentAdded = true;
  }

  return result;
}

function formatResult(result) {
  const parts = [`Updated ${result.issueKey}`];
  if (result.transitionedTo) parts.push(`status → ${result.transitionedTo}`);
  if (result.summaryUpdated) parts.push('summary updated');
  if (result.descriptionUpdated) parts.push('description updated');
  if (result.assignedTo) parts.push(`assignee → ${result.assignedTo}`);
  if (result.priority) parts.push(`priority → ${result.priority}`);
  if (result.labelsAdded?.length) parts.push(`labels +${result.labelsAdded.join(', +')}`);
  if (result.labelsRemoved?.length) parts.push(`labels -${result.labelsRemoved.join(', -')}`);
  if (result.commentAdded) parts.push('comment added');
  if (result.browseUrl) parts.push(`URL: ${result.browseUrl}`);
  return parts.join('; ');
}

module.exports = jiraUpdateTask;
module.exports.formatResult = formatResult;
module.exports.matchTransition = matchTransition;
