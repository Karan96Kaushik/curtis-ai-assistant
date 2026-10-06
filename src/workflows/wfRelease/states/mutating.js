const { createGithubClient, parseRepo } = require('../../../integrations/githubClient');
const { createJiraClient, browseUrl } = require('../../../integrations/jiraClient');
const { setField } = require('../fields');
const { audit, setState, STATES } = require('../context');
const { warn, ticketSummary, resolveCreateTicketType } = require('../helpers');
const { upsertDraftStep, markStepDone } = require('../draft');

function createdThisWorkflow(ctx, field) {
  return ctx.fields?.[field]?.source === 'jira_create';
}

/**
 * Planning state: add the QA-ticket create step to the draft.
 * Never reuses an existing ticket — every release gets a new QA ticket.
 */
async function createQaTicket(ctx) {
  const r = ctx.release;
  // Idempotent re-entry: skip only when THIS workflow already created the ticket.
  if (r.qa_ticket && createdThisWorkflow(ctx, 'qa_ticket')) {
    setState(ctx, STATES.CREATE_DEPLOYMENT_TICKET);
    return { continue: true };
  }
  r.qa_ticket = null;

  if (!r.development_project || !r.development_issue_type) {
    warn(ctx, 'Cannot create QA ticket — missing development project/type; skipping');
    upsertDraftStep(ctx, {
      type: 'create_qa_ticket',
      title: 'QA ticket',
      description: 'Skip QA ticket — missing development project/type.',
      skip: true,
      payload: null,
    });
    setState(ctx, STATES.CREATE_DEPLOYMENT_TICKET);
    return { continue: true };
  }

  const { issueType, parentKey } = resolveCreateTicketType(r);
  if (/sub[\s-]?task/i.test(String(r.development_issue_type || '')) && issueType === 'Task') {
    warn(
      ctx,
      'Dev ticket is a Sub-task without a usable parent — creating QA as Task instead'
    );
  }
  const payload = {
    projectKey: r.development_project,
    issueType,
    parentKey: parentKey || undefined,
    summary: ticketSummary('QA', ctx),
    description: [
      `QA for release ${r.next_version}`,
      `Repository: ${r.repository}`,
      `PR: ${r.source_pr || 'n/a'}`,
      `Development: ${r.development_ticket || 'n/a'}`,
      `Tag: ${r.next_version}`,
    ].join('\n'),
  };

  upsertDraftStep(ctx, {
    type: 'create_qa_ticket',
    title: 'Create QA ticket',
    description: [
      `Create Jira ${payload.issueType} in ${payload.projectKey}`,
      parentKey ? `under parent ${parentKey}` : null,
      `with summary "${payload.summary}".`,
      'Description will include PR, repo, development ticket, and version.',
    ]
      .filter(Boolean)
      .join(' '),
    payload,
  });
  audit(ctx, 'draft_plan_qa', payload);
  setState(ctx, STATES.CREATE_DEPLOYMENT_TICKET);
  return { continue: true, message: `Draft: plan QA ${payload.summary}` };
}

/**
 * Planning state: add the Deployment-ticket create step to the draft.
 * Never reuses an existing ticket — every release gets a new Deploy ticket.
 */
async function createDeploymentTicket(ctx) {
  const r = ctx.release;
  if (r.deployment_ticket && createdThisWorkflow(ctx, 'deployment_ticket')) {
    setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
    return { continue: true };
  }
  r.deployment_ticket = null;

  if (!r.development_project || !r.development_issue_type) {
    warn(ctx, 'Cannot create Deployment ticket — missing development project/type; skipping');
    upsertDraftStep(ctx, {
      type: 'create_deployment_ticket',
      title: 'Deployment ticket',
      description: 'Skip Deployment ticket — missing development project/type.',
      skip: true,
      payload: null,
    });
    setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
    return { continue: true };
  }

  const { issueType, parentKey } = resolveCreateTicketType(r);
  if (/sub[\s-]?task/i.test(String(r.development_issue_type || '')) && issueType === 'Task') {
    warn(
      ctx,
      'Dev ticket is a Sub-task without a usable parent — creating Deployment as Task instead'
    );
  }
  const payload = {
    projectKey: r.development_project,
    issueType,
    parentKey: parentKey || undefined,
    summary: ticketSummary('Deploy', ctx),
    description: [
      `Deployment for release ${r.next_version}`,
      `Repository: ${r.repository}`,
      `PR: ${r.source_pr || 'n/a'}`,
      `Development: ${r.development_ticket || 'n/a'}`,
      `QA: ${r.qa_ticket || 'n/a'}`,
      `Tag: ${r.next_version}`,
    ].join('\n'),
  };

  upsertDraftStep(ctx, {
    type: 'create_deployment_ticket',
    title: 'Create Deployment ticket',
    description: [
      `Create Jira ${payload.issueType} in ${payload.projectKey}`,
      parentKey ? `under parent ${parentKey}` : null,
      `with summary "${payload.summary}".`,
      'Description will include PR, repo, development/QA tickets, and version.',
    ]
      .filter(Boolean)
      .join(' '),
    payload,
  });
  audit(ctx, 'draft_plan_deploy', payload);
  setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
  return { continue: true, message: `Draft: plan Deploy ${payload.summary}` };
}

// ---------------------------------------------------------------------------
// Executors — called only after the user approved the draft and confirmed.
// ---------------------------------------------------------------------------

async function executeCreateTag(ctx, payload) {
  const r = ctx.release;
  const repo = payload.repo || r.repository;
  const tag = payload.tag || r.next_version;
  const sha = payload.sha || r.merge_commit;
  if (!repo || !tag || !sha) {
    throw new Error(`create_tag missing repo/tag/sha (repo=${repo} tag=${tag} sha=${sha})`);
  }
  const gh = createGithubClient();
  const { owner, repo: name } = parseRepo(repo);
  const result = await gh.createTag({
    owner,
    repo: name,
    tag,
    sha,
    message: payload.message || `Release ${tag}`,
  });
  r.next_version = tag;
  r.github_tag_created = true;
  r.merge_commit = sha;
  setField(ctx, 'next_version', tag, { confidence: 'high', source: 'github_tag' });
  audit(ctx, 'tag_created', { tag, sha, url: result.url });
  markStepDone(ctx, 'create_tag');
  return {
    text: `Created tag ${tag} on ${repo} @ ${sha}\n${result.url || result.html_url || ''}`,
    result,
  };
}

async function executeCreateQa(ctx, payload) {
  const jira = createJiraClient();
  let issueType = payload.issueType;
  let parentKey = payload.parentKey;
  // Repair older staged payloads that tried to create a bare Sub-task
  if (/sub[\s-]?task/i.test(String(issueType || ''))) {
    const resolved = resolveCreateTicketType(ctx.release);
    issueType = resolved.issueType;
    parentKey = resolved.parentKey || undefined;
  }
  const created = await jira.createIssue({
    projectKey: payload.projectKey,
    summary: payload.summary,
    issueType,
    description: payload.description,
    parentKey,
  });
  const key = created.key;
  ctx.release.qa_ticket = key;
  setField(ctx, 'qa_ticket', key, { confidence: 'high', source: 'jira_create' });
  audit(ctx, 'qa_ticket_created', { key, parentKey: parentKey || null, issueType });
  markStepDone(ctx, 'create_qa_ticket');
  return {
    text: `Created QA ticket ${key} (${issueType}${parentKey ? `, parent ${parentKey}` : ''})\n${browseUrl(jira.baseUrl, key)}`,
    result: { key, browseUrl: browseUrl(jira.baseUrl, key) },
  };
}

async function executeCreateDeploy(ctx, payload) {
  const jira = createJiraClient();
  let issueType = payload.issueType;
  let parentKey = payload.parentKey;
  if (/sub[\s-]?task/i.test(String(issueType || ''))) {
    const resolved = resolveCreateTicketType(ctx.release);
    issueType = resolved.issueType;
    parentKey = resolved.parentKey || undefined;
  }
  const created = await jira.createIssue({
    projectKey: payload.projectKey,
    summary: payload.summary,
    issueType,
    description: payload.description,
    parentKey,
  });
  const key = created.key;
  ctx.release.deployment_ticket = key;
  setField(ctx, 'deployment_ticket', key, { confidence: 'high', source: 'jira_create' });
  audit(ctx, 'deployment_ticket_created', { key, parentKey: parentKey || null, issueType });
  markStepDone(ctx, 'create_deployment_ticket');
  return {
    text: `Created Deployment ticket ${key} (${issueType}${parentKey ? `, parent ${parentKey}` : ''})\n${browseUrl(jira.baseUrl, key)}`,
    result: { key, browseUrl: browseUrl(jira.baseUrl, key) },
  };
}

module.exports = {
  createQaTicket,
  createDeploymentTicket,
  executeCreateTag,
  executeCreateQa,
  executeCreateDeploy,
};
