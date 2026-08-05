const { parseRepo } = require('../../integrations/githubClient');

const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const REPO_RE = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/;
const PR_RE = /(?:^|[^\w])#(\d+)\b|\bPR\s*#?\s*(\d+)\b|\bpull(?:\s+request)?\s*#?\s*(\d+)\b/i;
const BRANCH_RE = /\bbranch\s+([A-Za-z0-9._\/-]+)/i;
const FEATURE_BRANCH_RE = /\b((?:feature|bugfix|hotfix|release)\/[A-Za-z0-9._\/-]+)\b/i;

function parseStartInput(input = {}) {
  const text = String(input.text || input.prompt || '').trim();
  let repository = input.repo || input.repository || null;
  let source_pr = input.pr || input.source_pr || input.number || null;
  let source_branch = input.branch || input.source_branch || null;
  let development_ticket = input.jira || input.issue || input.development_ticket || null;

  if (!source_branch && text) {
    const m = text.match(BRANCH_RE) || text.match(FEATURE_BRANCH_RE);
    if (m) source_branch = m[1];
  }
  if (!repository && text) {
    const m = text.match(REPO_RE);
    if (m && !/^(feature|bugfix|hotfix|release)\//i.test(m[1])) {
      repository = m[1];
    }
  }
  if (!source_pr && text) {
    const m = text.match(PR_RE);
    if (m) source_pr = m[1] || m[2] || m[3];
  }
  if (!development_ticket && text) {
    const m = text.match(JIRA_KEY_RE);
    if (m) development_ticket = m[1].toUpperCase();
  }

  if (source_pr != null) source_pr = Number(source_pr) || source_pr;
  if (development_ticket) development_ticket = String(development_ticket).toUpperCase();

  let owner = null;
  let repoName = null;
  if (repository) {
    try {
      const parsed = parseRepo(repository);
      owner = parsed.owner;
      repoName = parsed.repo;
      repository = `${owner}/${repoName}`;
    } catch {
      /* leave as-is; IDENTIFY_SOURCE may ask */
    }
  }

  return {
    repository,
    owner,
    repoName,
    source_pr,
    source_branch,
    development_ticket,
    text,
    skip_tag:
      input.skip_tag === true ||
      input.skipTag === true ||
      /\bskip\s+(the\s+)?(git\s+)?tag\b/i.test(text) ||
      /\bwithout\s+(a\s+)?tag\b/i.test(text),
    draft:
      input.draft === true ||
      input.mode === 'draft' ||
      /\bdraft\b/i.test(text),
  };
}

function warn(ctx, message) {
  ctx.warnings = ctx.warnings || [];
  if (!ctx.warnings.includes(message)) ctx.warnings.push(message);
}

function componentFromRepo(repository) {
  if (!repository) return null;
  const parts = String(repository).split('/');
  return parts[1] || parts[0] || null;
}

function ticketSummary(prefix, ctx) {
  const ver = ctx.release.next_version || 'TBD';
  const component = ctx.release.component || ctx.release.repository || 'release';
  return `[${prefix}] Release ${ver} — ${component}`;
}

/**
 * Resolve issue type + optional parent for QA/Deploy creates.
 * Sub-tasks require a non-subtask parent in Jira. Prefer the development ticket's
 * parent; if the development ticket is a Sub-task with no parent known, fall back to Task.
 * @param {{
 *   development_issue_type?: string|null,
 *   development_ticket?: string|null,
 *   development_parent_key?: string|null,
 * }} release
 */
function resolveCreateTicketType(release = {}) {
  const rawType = String(release.development_issue_type || 'Task').trim() || 'Task';
  const isSubtask = /sub[\s-]?task/i.test(rawType);
  if (!isSubtask) {
    return { issueType: rawType, parentKey: null };
  }

  // Cannot nest Sub-tasks under another Sub-task — use the parent of the development ticket
  const parentKey = release.development_parent_key
    ? String(release.development_parent_key).trim().toUpperCase()
    : null;
  if (parentKey) {
    return { issueType: rawType, parentKey };
  }

  // No usable parent → create a normal Task in the same project
  return { issueType: 'Task', parentKey: null };
}

module.exports = {
  parseStartInput,
  warn,
  componentFromRepo,
  ticketSummary,
  resolveCreateTicketType,
  JIRA_KEY_RE,
};
