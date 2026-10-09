/**
 * Read-only smoke test of the Jira + GitHub tools against the real APIs in .env.
 * Never calls a write tool.
 *
 *   npm run test:integrations
 *
 * Optional: JIRA_TEST_PROJECT (default P25), JIRA_TEST_ISSUE (default: newest in project).
 */
require('dotenv').config();
require('../src/modules/index');
const registry = require('../src/core/moduleRegistry');
const identity = require('../src/integrations/identity');

const ctx = { channelId: 'integration-test', userId: 'integration-test' };
let failures = 0;

async function run(name, args) {
  if (registry.isMutatingTool(name)) throw new Error(`refusing write tool ${name}`);
  const started = Date.now();
  try {
    const result = await registry.getToolHandler(name)(args, ctx);
    const ok = result.envelope?.ok !== false;
    if (!ok) failures += 1;
    const preview = String(result.text).split('\n').slice(0, 12).join('\n');
    console.log(`\n### ${name} ok=${ok} (${Date.now() - started}ms)\n${preview}`);
    return result;
  } catch (err) {
    failures += 1;
    console.log(`\n### ${name} FAILED (${Date.now() - started}ms): ${err.message}`);
    return null;
  }
}

async function main() {
  await identity.warm({ timeoutMs: 10000 });
  const { jira, github } = identity.snapshot();
  console.log(`identity — jira: ${jira?.displayName || '(none)'} | github: ${github?.login || '(none)'} orgs: ${(github?.orgs || []).join(', ') || '(none)'}`);

  if (jira) {
    const project = process.env.JIRA_TEST_PROJECT || 'P25';
    const search = await run('jira_search', {
      jql: `project = ${project} ORDER BY updated DESC`,
      max: 3,
    });
    const issue = process.env.JIRA_TEST_ISSUE || search?.envelope?.data?.issues?.[0]?.key;
    if (issue) {
      await run('jira_get_issue', { issue });
      await run('jira_get_transitions', { issue });
    }
    await run('jira_list_projects', { query: project });
    await run('jira_list_projects', { project });
    await run('jira_find_user', { query: (jira.displayName || '').split(' ')[0], max: 3 });
    await run('jira_my_issues', { max: 3 });
  }

  if (github) {
    const prs = await run('github_search_prs', { query: 'author:@me', max: 3 });
    const pr = prs?.envelope?.data?.pulls?.[0];
    if (pr?.repo) {
      await run('github_get_pr', { repo: pr.repo, number: pr.number });
      await run('github_get_repo', { repo: pr.repo });
      await run('github_list_branches', { repo: pr.repo, max: 5 });
      await run('github_list_commits', { repo: pr.repo, max: 3 });
      await run('github_get_file', { repo: pr.repo, path: '' });
      const tags = await run('github_list_tags', { repo: pr.repo, max: 2 });
      const base = tags?.envelope?.data?.tags?.[0]?.name;
      if (base) await run('github_compare', { repo: pr.repo, base });
      await run('github_search_issues', { repo: pr.repo, state: 'all', max: 3 });
    }
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll integration checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
