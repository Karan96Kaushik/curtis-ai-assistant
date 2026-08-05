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
  if (args.description) {
    const preview = String(args.description).slice(0, 400);
    lines.push(`- Description:\n${preview}${args.description.length > 400 ? '…' : ''}`);
  }
  return lines.join('\n');
}

function summarizeUpdate(args) {
  const lines = [`Update ${args.issue}`];
  if (args.status) lines.push(`- Status → ${args.status}`);
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
    const type = args.type || args.payload?.type || '?';
    const payload = args.payload || {};
    const lines = [
      'WF Release pending action',
      `- Workflow: ${args.workflowId || '?'}`,
      `- Type: ${type}`,
    ];
    if (type === 'create_tag') {
      lines.push(`- Repo: ${payload.repo || '?'}`);
      lines.push(`- Tag: ${payload.tag || '?'}`);
      if (payload.sha) lines.push(`- SHA: ${payload.sha}`);
      if (payload.reason) lines.push(`- Reason: ${payload.reason}`);
    } else if (type === 'create_qa_ticket' || type === 'create_deployment_ticket') {
      lines.push(`- Project: ${payload.projectKey || '?'}`);
      lines.push(`- Type: ${payload.issueType || '?'}`);
      if (payload.parentKey) lines.push(`- Parent: ${payload.parentKey}`);
      lines.push(`- Summary: ${payload.summary || '?'}`);
    } else if (type === 'execute_draft') {
      const steps = payload.steps || [];
      const writes = steps.filter((s) => !s.skip && !s.reuse && s.payload);
      lines.push(`- Execute full draft (${writes.length} write(s))`);
      for (const s of writes) {
        lines.push(`  • ${s.title || s.type}`);
      }
    } else if (type === 'link_jira') {
      lines.push(`- Link type: ${payload.type || 'Relates'}`);
      for (const pair of payload.pairs || []) {
        lines.push(`- ${pair.inwardKey} → ${pair.outwardKey}`);
      }
    } else {
      lines.push(`- Payload: ${JSON.stringify(payload).slice(0, 400)}`);
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
  return 'chat';
}

module.exports = {
  get,
  set,
  clear,
  take,
  buildSummary,
  domainFromTool,
  sessionKey,
};
