/**
 * Cached "who am I" for Jira and GitHub, plus the GitHub orgs used to scope
 * cross-searches. Warmed once per process; never throws.
 */

const config = require('../config');
const { createJiraClient, isJiraConfigured } = require('./jiraClient');
const { createGithubClient, isGithubConfigured } = require('./githubClient');

const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * @type {{
 *   jira: { accountId: string|null, displayName: string|null, timeZone: string|null, baseUrl: string } | null,
 *   github: { login: string, name: string|null, orgs: string[] } | null,
 *   warmedAt: number,
 * }}
 */
const state = { jira: null, github: null, warmedAt: 0 };
/** @type {Promise<void> | null} */
let inflight = null;

async function loadJira() {
  if (!isJiraConfigured()) return;
  const jira = createJiraClient();
  const me = await jira.getMyself();
  state.jira = {
    accountId: me.accountId || null,
    displayName: me.displayName || null,
    timeZone: me.timeZone || null,
    baseUrl: jira.baseUrl,
  };
}

async function loadGithub() {
  if (!isGithubConfigured()) return;
  const github = createGithubClient();
  const [user, orgs] = await Promise.all([
    github.getAuthenticatedUser(),
    github.listMyOrgs().catch(() => []),
  ]);
  state.github = {
    login: user.login,
    name: user.name || null,
    orgs: (Array.isArray(orgs) ? orgs : []).map((o) => o.login).filter(Boolean),
  };
}

function settle(label, promise) {
  return promise.catch((err) => {
    console.error(`[identity] ${label} lookup failed:`, err.message || err);
  });
}

/**
 * Load identities if stale. Resolves after `timeoutMs` at the latest; a slow
 * lookup keeps running in the background and fills the cache when it lands.
 * @param {{ timeoutMs?: number }} [opts]
 */
async function warm({ timeoutMs = 2500 } = {}) {
  if (state.warmedAt && Date.now() - state.warmedAt < TTL_MS) return;
  if (!inflight) {
    inflight = Promise.all([settle('jira', loadJira()), settle('github', loadGithub())]).then(() => {
      state.warmedAt = Date.now();
      inflight = null;
    });
  }
  await Promise.race([inflight, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

/** Orgs used to scope GitHub cross-searches: config first, then token memberships. */
async function githubOrgs() {
  if (config.GITHUB_ORGS.length) return config.GITHUB_ORGS;
  await warm();
  return state.github?.orgs || [];
}

function snapshot() {
  return { jira: state.jira, github: state.github };
}

module.exports = { warm, githubOrgs, snapshot };
