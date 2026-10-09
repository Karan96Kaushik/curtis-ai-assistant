/**
 * Application config — change values here at the code level.
 * Optional env vars override these defaults when set.
 */

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const items = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

/** "Name=VALUE,Other=VAL2" → { Name: 'VALUE', Other: 'VAL2' } */
function envMap(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const out = {};
  for (const pair of String(raw).split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length ? out : fallback;
}

module.exports = {
  /**
   * Hard gate for AI create/update/delete:
   * - true  → mutating tools only stage a plan; Jira writes run after the user
   *           confirms in a later message (confirm_pending). Same-turn confirm is blocked.
   * - false → mutating tools execute immediately (no confirmation step).
   *
   * Toggle here, or set REQUIRE_CONFIRMATION=0|1 in .env to override.
   */
  REQUIRE_CONFIRMATION: envBool('REQUIRE_CONFIRMATION', true),

  /** Localhost WS port for the Firefox extension bridge. */
  EXTENSION_WS_PORT: envInt('EXTENSION_WS_PORT', 8765),

  /**
   * Optional shared secret. If set, the extension must send the same token in hello.
   * Empty string = no token required.
   */
  EXTENSION_WS_TOKEN: String(process.env.EXTENSION_WS_TOKEN || '').trim(),

  /** Directory for persisted ReleaseContext JSON and export artifacts. */
  WF_RELEASE_DIR: String(process.env.WF_RELEASE_DIR || 'context/releases').trim() || 'context/releases',

  /**
   * Extra GitHub logins that belong to the same person as GITHUB_TOKEN.
   * Searched with full coverage (commits, PRs, reviews, issues, comments)
   * alongside the authenticated account. Override with GITHUB_ACTIVITY_LOGINS.
   */
  GITHUB_ACTIVITY_LOGINS: envList('GITHUB_ACTIVITY_LOGINS', ['Karan96Kaushik']),

  /**
   * Git author/committer identities that also belong to the user: a name
   * fragment like "karan", or a full address like "karan@example.com".
   * Catches commits made under a git identity not linked to any account.
   * Commit-level only — PR/issue search cannot filter by git name/email.
   * Hits are re-verified locally, so a fragment can never pull in a stranger,
   * and the search is scoped to orgs/users this token can already see.
   * Override with GITHUB_ACTIVITY_ALIASES.
   */
  GITHUB_ACTIVITY_ALIASES: envList('GITHUB_ACTIVITY_ALIASES', ['karan']),

  /**
   * Repo owners to leave out of activity reports entirely — their repos are
   * skipped and they are dropped from alias search scope.
   * Override with GITHUB_ACTIVITY_EXCLUDE_OWNERS.
   */
  GITHUB_ACTIVITY_EXCLUDE_OWNERS: envList('GITHUB_ACTIVITY_EXCLUDE_OWNERS', ['Karan96Kaushik']),

  /**
   * Sweep every branch of recently-pushed repos when building activity
   * reports. GitHub's commit search only indexes default branches, so without
   * this, feature-branch commits are invisible. Costs extra REST calls.
   * Override with GITHUB_ACTIVITY_ALL_BRANCHES=0.
   */
  GITHUB_ACTIVITY_ALL_BRANCHES: envBool('GITHUB_ACTIVITY_ALL_BRANCHES', true),

  /**
   * GitHub orgs that hold the team's code. Scopes cross-searches such as
   * "PRs mentioning P25-1234" so they never hit unrelated public repos.
   * Empty → the orgs the GITHUB_TOKEN user belongs to. Override with GITHUB_ORGS.
   */
  GITHUB_ORGS: envList('GITHUB_ORGS', []),

  /**
   * Repos (owner/name) the user works in most; offered to the model as
   * defaults when a request names no repo. Override with GITHUB_DEFAULT_REPOS.
   */
  GITHUB_DEFAULT_REPOS: envList('GITHUB_DEFAULT_REPOS', []),

  /**
   * Friendly board/project names → Jira project keys.
   * Override with JIRA_PROJECT_ALIASES="Platform 25=P25,Other Board=OB".
   */
  JIRA_PROJECT_ALIASES: envMap('JIRA_PROJECT_ALIASES', { 'Platform 25': 'P25' }),

  /** Link Jira issues and GitHub PRs in tool results. Override with CROSS_LINK_JIRA_GITHUB=0. */
  CROSS_LINK_JIRA_GITHUB: envBool('CROSS_LINK_JIRA_GITHUB', true),
};
