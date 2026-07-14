const { createJiraClient } = require('../integrations/jiraClient');

/**
 * Verify Jira auth and return the authenticated user profile.
 */
async function jiraWhoamiTask() {
  const jira = createJiraClient();
  console.error('[jira-whoami]', `baseUrl=${jira.baseUrl}`);
  console.error('[jira-whoami]', `authEmail=${jira.email}`);

  const myself = await jira.getMyself();
  return {
    baseUrl: jira.baseUrl,
    authEmail: jira.email,
    accountId: myself.accountId || null,
    displayName: myself.displayName || null,
    emailAddress: myself.emailAddress || null,
    active: myself.active,
    timeZone: myself.timeZone || null,
    accountType: myself.accountType || null,
  };
}

function formatResult(result) {
  return [
    'Jira connection OK',
    `  Base URL:     ${result.baseUrl}`,
    `  Auth email:   ${result.authEmail}`,
    `  Display name: ${result.displayName}`,
    `  Profile email:${result.emailAddress || '(none returned)'}`,
    `  Account ID:   ${result.accountId}`,
    `  Active:       ${result.active}`,
    `  Time zone:    ${result.timeZone || '(none)'}`,
    `  Account type: ${result.accountType || '(none)'}`,
  ].join('\n');
}

module.exports = jiraWhoamiTask;
module.exports.formatResult = formatResult;
