/**
 * Pending mutating actions awaiting user confirmation (per Discord channel + user).
 */

const DEFAULT_TTL_MS = Number(process.env.PENDING_ACTION_TTL_MS) || 30 * 60 * 1000;

/**
 * @typedef {{ tool: string, args: object, summary: string, createdAt: number, turnId: string|null }} PendingAction
 * @type {Map<string, PendingAction>}
 */
const store = new Map();

function sessionKey(channelId, userId) {
  return `${channelId}:${userId}`;
}

function get(channelId, userId) {
  const key = sessionKey(channelId, userId);
  const pending = store.get(key);
  if (!pending) return null;
  if (Date.now() - pending.createdAt > DEFAULT_TTL_MS) {
    store.delete(key);
    return null;
  }
  return pending;
}

function set(channelId, userId, { tool, args, summary, turnId = null }) {
  const entry = {
    tool,
    args: { ...args },
    summary: String(summary || ''),
    createdAt: Date.now(),
    turnId: turnId != null ? String(turnId) : null,
  };
  store.set(sessionKey(channelId, userId), entry);
  return entry;
}

function clear(channelId, userId) {
  store.delete(sessionKey(channelId, userId));
}

function clearChannel(channelId) {
  const prefix = `${channelId}:`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/**
 * Take (get + clear) pending action if present and not expired.
 */
function take(channelId, userId) {
  const pending = get(channelId, userId);
  if (!pending) return null;
  clear(channelId, userId);
  return pending;
}

function summarizeCreate(args) {
  const lines = [
    'Create Jira issue',
    `- Project: ${args.project}`,
    `- Type: ${args.type || 'Task'}`,
    `- Summary: ${args.summary}`,
    `- Assign to you: ${args.assign_me !== false ? 'yes' : 'no'}`,
  ];
  if (args.parent) lines.push(`- Parent: ${args.parent}`);
  if (args.priority) lines.push(`- Priority: ${args.priority}`);
  if (args.labels) lines.push(`- Labels: ${[].concat(args.labels).join(', ')}`);
  if (args.components) lines.push(`- Components: ${[].concat(args.components).join(', ')}`);
  if (args.description) {
    const preview = String(args.description).slice(0, 400);
    lines.push(`- Description:\n${preview}${args.description.length > 400 ? '…' : ''}`);
  }
  return lines.join('\n');
}

function summarizeUpdate(args) {
  const lines = [`Update ${args.issue}`];
  if (args.status) lines.push(`- Status → ${args.status}`);
  if (args.summary) lines.push(`- Summary → ${args.summary}`);
  if (args.assignee) lines.push(`- Assignee → ${args.assignee}`);
  if (args.priority) lines.push(`- Priority → ${args.priority}`);
  if (args.add_labels) lines.push(`- Add labels: ${[].concat(args.add_labels).join(', ')}`);
  if (args.remove_labels) lines.push(`- Remove labels: ${[].concat(args.remove_labels).join(', ')}`);
  if (args.description !== undefined) {
    const preview = String(args.description).slice(0, 400);
    lines.push(
      `- Description (replace):\n${preview}${String(args.description).length > 400 ? '…' : ''}`
    );
  }
  if (args.comment) lines.push(`- Add comment: ${String(args.comment).slice(0, 200)}`);
  return lines.join('\n');
}

function summarizeDeleteComment(args) {
  const lines = [`Delete comment on ${args.issue}`];
  if (args.delete_last) lines.push('- Target: last (most recent) comment');
  if (args.comment_id) lines.push(`- Comment id: ${args.comment_id}`);
  return lines.join('\n');
}

function buildSummary(tool, args) {
  if (tool === 'jira_create') return summarizeCreate(args);
  if (tool === 'jira_update') return summarizeUpdate(args);
  if (tool === 'jira_delete_comment') return summarizeDeleteComment(args);
  if (tool === 'jira_link_issues') {
    return `Link Jira issues\n- ${args.from} ${String(args.type || 'Relates')} → ${args.to}`;
  }
  if (tool === 'jira_log_work') {
    const lines = ['Log work in Jira', `- Issue: ${args.issue}`, `- Time: ${args.time_spent}`];
    if (args.started) lines.push(`- Started: ${args.started}`);
    if (args.comment) lines.push(`- Note: ${String(args.comment).slice(0, 200)}`);
    return lines.join('\n');
  }
  if (tool === 'github_add_comment') {
    return [
      'Comment on GitHub',
      `- Target: ${args.repo || '?'}#${args.number ?? '?'}`,
      `- Comment: ${String(args.body || '').slice(0, 400)}`,
    ].join('\n');
  }
  if (tool === 'github_create_issue') {
    const lines = ['Create GitHub issue', `- Repo: ${args.repo || '?'}`, `- Title: ${args.title}`];
    if (args.labels) lines.push(`- Labels: ${[].concat(args.labels).join(', ')}`);
    if (args.assignees) lines.push(`- Assignees: ${[].concat(args.assignees).join(', ')}`);
    if (args.body) lines.push(`- Body:\n${String(args.body).slice(0, 400)}`);
    return lines.join('\n');
  }
  if (tool === 'browser_open_tab') return `Open browser tab\n- URL: ${args.url}`;
  if (tool === 'browser_navigate') return `Navigate browser tab\n- URL: ${args.url}${args.tab_id != null ? `\n- Tab: ${args.tab_id}` : ''}`;
  if (tool === 'browser_click') return `Click in browser\n- Selector: ${args.selector}`;
  if (tool === 'browser_type') return `Type in browser\n- Selector: ${args.selector}\n- Text: ${String(args.text || '').slice(0, 200)}`;
  if (tool === 'teams_open') return `Open Microsoft Teams\n- URL: ${args.url || 'https://teams.cloud.microsoft/'}`;
  if (tool === 'github_create_tag') {
    const lines = [
      'Create GitHub tag',
      `- Repo: ${args.repo || (args.owner ? `${args.owner}/…` : '?')}`,
      `- Tag: ${args.tag}`,
    ];
    if (args.sha) lines.push(`- SHA: ${args.sha}`);
    if (args.branch || args.ref) lines.push(`- Branch/ref: ${args.branch || args.ref}`);
    if (args.message) lines.push(`- Message: ${String(args.message).slice(0, 200)}`);
    return lines.join('\n');
  }
  if (tool === 'wf_release_execute_pending') {
    const payload = args.payload || {};
    if (args.type === 'execute_step' && payload.step) {
      const s = payload.step;
      const detail = s.payload?.summary || s.payload?.tag || '';
      return [
        `Release step: ${s.title || s.type}${detail ? ` — ${detail}` : ''}`,
        `- Workflow: ${args.workflowId || '?'}`,
      ].join('\n');
    }
    const steps = (payload.steps || []).filter((s) => !s.skip && s.payload);
    const lines = [
      'Execute release draft',
      `- Workflow: ${args.workflowId || '?'}`,
      `- ${steps.length} write(s) will run in order:`,
    ];
    for (const s of steps) {
      const detail = s.payload?.summary || s.payload?.tag || '';
      lines.push(`  • ${s.title || s.type}${detail ? ` — ${detail}` : ''}`);
    }
    return lines.join('\n');
  }
  return `${tool}: ${JSON.stringify(args)}`;
}

/** Map a pending tool name to an intent domain. */
function domainFromTool(tool) {
  const name = String(tool || '');
  if (name.startsWith('jira_')) return 'jira';
  if (name.startsWith('github_')) return 'github';
  if (name.startsWith('teams_')) return 'teams';
  if (name.startsWith('browser_')) return 'browser';
  if (name.startsWith('wf_release_')) return 'release';
  if (name === 'request_phone_notifications') return 'phone';
  if (name === 'clear_chat' || name === 'clear_context') return 'meta';
  return 'chat';
}

module.exports = {
  get,
  set,
  clear,
  clearChannel,
  take,
  buildSummary,
  domainFromTool,
  sessionKey,
};
