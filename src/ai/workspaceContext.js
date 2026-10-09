/**
 * Structured workspace facts for the system prompt: who the user is in Jira
 * and GitHub, project aliases, repo defaults, and what the conversation was
 * last about (so "it" / "that PR" resolve without guessing).
 */

const config = require('../config');
const identity = require('../integrations/identity');

/**
 * @param {{ lastIssueKey?: string|null, lastGithubRef?: { full_name: string, number: number|null, kind: string } | null }} [recent]
 * @returns {string}
 */
function forPrompt(recent = {}) {
  const { jira, github } = identity.snapshot();
  const lines = [];

  if (jira) {
    lines.push(
      `- Jira: signed in as ${jira.displayName || '?'} (accountId ${jira.accountId || '?'}${jira.timeZone ? `, tz ${jira.timeZone}` : ''}) at ${jira.baseUrl}. In JQL, "me" = currentUser().`
    );
  }
  const aliases = Object.entries(config.JIRA_PROJECT_ALIASES || {});
  if (aliases.length) {
    lines.push(`- Jira project aliases: ${aliases.map(([name, key]) => `${name} → ${key}`).join('; ')}`);
  }

  if (github) {
    lines.push(`- GitHub: signed in as @${github.login}${github.name ? ` (${github.name})` : ''}. In search, "me" = @me.`);
  }
  const orgs = config.GITHUB_ORGS.length ? config.GITHUB_ORGS : github?.orgs || [];
  if (orgs.length) lines.push(`- GitHub orgs: ${orgs.join(', ')} (scope searches with org:<name>)`);
  if (config.GITHUB_DEFAULT_REPOS.length) {
    lines.push(`- Default repos when none is named: ${config.GITHUB_DEFAULT_REPOS.join(', ')}`);
  }

  const refs = [];
  if (recent.lastIssueKey) refs.push(`Jira ${recent.lastIssueKey}`);
  if (recent.lastGithubRef?.full_name) {
    const r = recent.lastGithubRef;
    refs.push(
      r.number != null
        ? `GitHub ${r.kind === 'issue' ? 'issue' : 'PR'} ${r.full_name}#${r.number}`
        : `GitHub repo ${r.full_name}`
    );
  }
  if (refs.length) {
    lines.push(`- Most recently discussed: ${refs.join('; ')} — "it"/"that one" likely means these.`);
  }

  return lines.length ? ['Workspace context:', ...lines].join('\n') : '';
}

module.exports = { forPrompt };
