/**
 * Jira ↔ GitHub linking: PRs that mention an issue key, and the Jira issues a
 * PR (or commit range) references. Best-effort — failures return empty lists.
 */

const config = require('../config');
const { createJiraClient, isJiraConfigured, JiraError, browseUrl } = require('./jiraClient');
const { createGithubClient, isGithubConfigured } = require('./githubClient');
const { extractIssueKeys } = require('../util/jiraKeys');
const identity = require('./identity');

/** Prefixes that look like issue keys but are standards/encodings. */
const NOT_ISSUE_PREFIXES = new Set(['UTF', 'ISO', 'SHA', 'RFC', 'HTTP', 'TLS', 'SSL', 'CVE', 'MD', 'AES', 'RSA', 'X', 'PR', 'V']);

/**
 * Jira keys referenced in free text (PR titles, branch names, commit messages).
 * @param {...string} texts
 * @returns {string[]}
 */
function jiraKeysIn(...texts) {
  return extractIssueKeys(texts.filter(Boolean).join('\n')).filter(
    (key) => !NOT_ISSUE_PREFIXES.has(key.split('-')[0])
  );
}

/**
 * PRs in the team's orgs whose title/body/branch mention a Jira key.
 * @param {string} issueKey
 * @param {{ max?: number }} [opts]
 * @returns {Promise<{ repo: string|null, number: number, title: string, state: string, html_url: string, user: string|null }[]>}
 */
async function prsForJiraKey(issueKey, { max = 5 } = {}) {
  if (!config.CROSS_LINK_JIRA_GITHUB || !isGithubConfigured()) return [];
  try {
    const orgs = await identity.githubOrgs();
    const scope = orgs.length ? orgs.map((o) => `org:${o}`).join(' ') : 'involves:@me';
    const github = createGithubClient();
    const data = await github.searchPulls({
      q: `"${issueKey}" ${scope}`,
      per_page: max,
      sort: 'updated',
      order: 'desc',
    });
    return (data.items || []).map((p) => ({
      repo: p.repository_url
        ? String(p.repository_url).replace(/^https:\/\/api\.github\.com\/repos\//, '')
        : null,
      number: p.number,
      title: p.title,
      state: p.pull_request?.merged_at ? 'merged' : p.state,
      html_url: p.html_url,
      user: p.user?.login || null,
    }));
  } catch (err) {
    console.error(`[cross-link] PR search for ${issueKey} failed:`, err.message || err);
    return [];
  }
}

/**
 * Summaries for Jira keys; keys that 404 (false positives) are dropped.
 * @param {string[]} keys
 * @param {{ max?: number }} [opts]
 * @returns {Promise<{ key: string, summary: string, status: string, browseUrl: string|null }[]>}
 */
async function jiraIssuesForKeys(keys, { max = 3 } = {}) {
  if (!config.CROSS_LINK_JIRA_GITHUB || !isJiraConfigured() || !keys?.length) return [];
  const jira = createJiraClient();
  const results = await Promise.all(
    keys.slice(0, max).map(async (key) => {
      try {
        const issue = await jira.getIssue(key, { fields: ['summary', 'status'] });
        return {
          key: issue.key || key,
          summary: issue.fields?.summary || '(no summary)',
          status: issue.fields?.status?.name || 'Unknown',
          browseUrl: browseUrl(jira.baseUrl, issue.key || key),
        };
      } catch (err) {
        if (!(err instanceof JiraError) || (err.status !== 404 && err.status !== 400)) {
          console.error(`[cross-link] Jira lookup for ${key} failed:`, err.message || err);
        }
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

module.exports = { jiraKeysIn, prsForJiraKey, jiraIssuesForKeys };
