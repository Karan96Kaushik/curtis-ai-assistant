// Offline end-to-end check of the step-by-step release flow with mocked clients.
const path = require('path');
const assert = require('assert');
process.env.WF_RELEASE_DIR = path.join(__dirname, '.tmp-wf-releases');
process.env.JIRA_BASE_URL = 'https://example.atlassian.net';
process.env.REQUIRE_CONFIRMATION = 'true';

const calls = [];
const ghMock = {
  getPull: async () => ({
    title: 'Feature/db error handling', body: 'Fixes P25-100', head: { ref: 'feature/x', sha: 'headsha' },
    merge_commit_sha: 'mergesha', merged: true, user: { login: 'KKFPS' }, requested_reviewers: [],
    html_url: 'https://github.com/o/func_x/pull/21',
  }),
  listPullCommits: async () => [{ sha: 'a', commit: { message: 'fix db errors', author: { name: 'K' } } }],
  listPullFiles: async () => [{ filename: 'app.py' }],
  getCombinedStatus: async ({ ref }) => ({
    state: 'success',
    statuses: ref === 'headsha'
      ? [{ context: 'security/snyk (PNFPS)', state: 'error', target_url: 'https://app.snyk.io/x', description: '1 high issue' }]
      : [],
  }),
  listCheckRuns: async () => ({ check_runs: [] }),
  listTags: async () => [{ name: 'v2.3.0' }, { name: 'v2.4.0' }],
  createTag: async (a) => { calls.push(['tag', a.tag, a.sha]); return { url: 'u' }; },
};
let jiraN = 500;
const jiraMock = {
  baseUrl: 'https://example.atlassian.net',
  getIssue: async () => ({ fields: { summary: 'DB errors', status: { name: 'Done' }, issuetype: { name: 'Task' }, project: { key: 'P25' }, assignee: { displayName: 'Karan Kaushik' } } }),
  searchIssues: async () => ({ issues: [] }),
  createIssue: async (a) => { const key = `P25-${++jiraN}`; calls.push(['issue', key, a.summary, a.projectKey, a.issueType, a.description]); return { key }; },
};
const llmReply = {
  release_summary: 'Improves DB error handling', technical_summary: 'x', feature_group: 'N/A', software_stack_changes: 'N/A',
  rollback_plan: 'code update/rollback to v2.4.0', risk: 'r', security: 'N/A', customer_impact: 'N/A',
  monitoring_owner: 'Karan - azure logs - 24h', snyk_security: null, guessed: ['risk'],
};
const mock = (rel, exportsObj) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
};
const realGh = require('./src/integrations/githubClient');
mock('./src/integrations/githubClient', { ...realGh, createGithubClient: () => ghMock });
const realJira = require('./src/integrations/jiraClient');
mock('./src/integrations/jiraClient', { ...realJira, createJiraClient: () => jiraMock });
mock('./src/integrations/aiRouter', { chat: async () => ({ message: { content: JSON.stringify(llmReply) } }) });

const pendingActions = require('./src/ai/pendingActions');
require('./src/modules/index');
const registry = require('./src/core/moduleRegistry');
const release = require('./src/modules/release');
const intentRouter = require('./src/ai/intentRouter');

const ctx = { channelId: 'c1', userId: 'u1', _turnId: 't0' };
const call = (name, args) => registry.getToolHandler(name)(args, ctx);
const confirm = async () => { ctx._turnId = `t${Math.random()}`; return call('confirm_pending', {}); };

(async () => {
  // 1. Draft
  let r = await call('wf_release_start', { repo: 'o/func_x', pr: 21 });
  const id = r.envelope.data.workflowId;
  assert.strictEqual(r.envelope.data.state, 'DRAFT_REVIEW');
  assert.ok(r.text.includes('**Developer**: Karan Kaushik'), 'developer from Jira assignee');
  assert.ok(/Snyk PR check failing: security\/snyk \(PNFPS\) — 1 high issue/.test(r.text), 'snyk from PR check');
  assert.ok(r.text.includes('**Release risks**: r _(best guess'), 'guess flag');
  assert.ok(r.text.includes('Atakan _(best guess from role)_'));
  assert.strictEqual(calls.length, 0, 'no writes in draft');

  // 2. Revise: QA project/type, deploy title, component -> summaries resync
  r = await call('wf_release_revise_draft', { id, qa_issue_type: 'QAlity Test', deploy_summary: 'Deploy custom', component: 'FuncX' });
  assert.ok(r.text.includes('Project: P25 (QAlity Test)'));
  assert.ok(r.text.includes('Summary: TEST FuncX v2.5.0'), 'QA title resynced to component');
  assert.ok(r.text.includes('Summary: Deploy custom'));

  // 3. Approve -> only the tag is staged
  r = await call('wf_release_approve_draft', { id });
  let p = pendingActions.get('c1', 'u1');
  assert.strictEqual(p.args.type, 'execute_step');
  assert.strictEqual(p.args.payload.step.type, 'create_tag');
  assert.ok(pendingActions.buildSummary(p.tool, p.args).startsWith('Release step: Create Git tag — v2.5.0'));

  // 4. Confirm tag -> QA staged
  r = await confirm();
  assert.deepStrictEqual(calls[0], ['tag', 'v2.5.0', 'mergesha']);
  p = pendingActions.get('c1', 'u1');
  assert.strictEqual(p.args.payload.step.type, 'create_qa_ticket');
  assert.ok(r.text.includes('Step 2 of 3'), r.text);

  // 5. Edit while QA is staged: tag edit ignored (already done), QA title applied
  const intent = intentRouter.classify('change the QA title to TEST special', { hasPending: true, pendingTool: p.tool, pendingArgs: p.args });
  assert.strictEqual(intent.domain, 'release');
  r = await call('wf_release_revise_draft', { id, tag: 'v9.9.9', qa_summary: 'TEST special' });
  assert.ok(r.text.includes('Tag already created'), 'tag edit ignored');
  p = pendingActions.get('c1', 'u1');
  assert.strictEqual(p.args.payload.step.type, 'create_qa_ticket', 'QA re-staged');

  // 6. Confirm QA -> deploy staged; deploy body now has the QA key
  r = await confirm();
  assert.strictEqual(calls[1][2], 'TEST special');
  assert.strictEqual(calls[1][4], 'QAlity Test');
  p = pendingActions.get('c1', 'u1');
  assert.strictEqual(p.args.payload.step.type, 'create_deployment_ticket');

  // 7. Confirm deploy -> complete with the full form
  r = await confirm();
  assert.ok(/QA: P25-501/.test(calls[2][5]), 'deploy body includes new QA key');
  assert.strictEqual(pendingActions.get('c1', 'u1'), null, 'no stale pending');
  assert.ok(r.text.includes('# Release form'), r.text.slice(0, 400));
  assert.ok(r.text.includes('**QAlity test ref**: P25-501 (https://example.atlassian.net/browse/P25-501)'));
  assert.ok(r.text.includes('**Jira Task for deployment to prod**: P25-502'));
  assert.ok(r.text.includes('tag v2.5.0: https://github.com/o/func_x/releases/tag/v2.5.0'));
  for (const f of ['Release #', 'Developer', 'Component', 'Release Summary', 'Product Release - Feature Group', 'Release Submission Date', 'Previous release #', 'New release #', 'Github link', 'Jira Task Ref', 'QAlity test ref', 'Jira Task for deployment to prod', 'Changes to software stack', 'Snyk security issues', 'Release risks', 'Release rollback / backout plan', 'Potential to contact the customer directly', 'Release security', 'Post-release monitoring']) {
    assert.ok(r.text.includes(`**${f}**:`), `missing ${f}`);
  }

  // 8. Second run: skip + run all remaining
  calls.length = 0;
  r = await call('wf_release_start', { repo: 'o/func_x', pr: 21 });
  const id2 = r.envelope.data.workflowId;
  await call('wf_release_approve_draft', { id: id2 });
  p = pendingActions.get('c1', 'u1');
  pendingActions.clear('c1', 'u1');
  r = await release.rejectIfReleasePending(p, ctx, { skip: true });
  p = pendingActions.get('c1', 'u1');
  assert.strictEqual(p.args.payload.step.type, 'create_qa_ticket', 'skip tag -> QA staged');
  const runAllIntent = intentRouter.classify('run all remaining', { hasPending: true, pendingTool: p.tool, pendingArgs: p.args });
  assert.ok(runAllIntent.runAll);
  r = await call('wf_release_approve_draft', { id: id2, run_all: true });
  p = pendingActions.get('c1', 'u1');
  assert.strictEqual(p.args.type, 'execute_draft');
  assert.strictEqual(p.args.payload.steps.length, 2);
  r = await confirm();
  assert.strictEqual(calls.length, 2, 'QA + deploy only');
  assert.ok(r.text.includes('tag v2.5.0: tag skipped'));
  assert.ok(r.text.includes('# Release form'));

  // 9. Stale confirm is refused
  r = await registry.getToolHandler('wf_release_execute_pending')({ workflowId: id2, type: 'execute_step', __confirmed: true }, ctx);
  assert.ok(r.text.includes('Nothing is waiting for confirmation'));

  console.log('ALL RELEASE FLOW CHECKS PASSED');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
