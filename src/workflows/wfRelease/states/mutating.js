const { createGithubClient, parseRepo } = require('../../../integrations/githubClient');
const { createJiraClient, browseUrl } = require('../../../integrations/jiraClient');
const { setField } = require('../fields');
const { audit, setState, STATES } = require('../context');
const {
  warn,
  ticketSummary,
  resolveCreateTicketType,
  qaDescription,
  deployDescription,
  ticketStepDescription,
} = require('../helpers');
const { upsertDraftStep, markStepDone } = require('../draft');

function createdThisWorkflow(ctx, field) {
  return ctx.fields?.[field]?.source === 'jira_create';
}

const TICKETS = {
  qa: {
    stepType: 'create_qa_ticket',
    title: 'Create QA ticket',
    label: 'QA',
    field: 'qa_ticket',
    next: STATES.CREATE_DEPLOYMENT_TICKET,
    describe: qaDescription,
  },
  deploy: {
    stepType: 'create_deployment_ticket',
    title: 'Create Deployment ticket',
    label: 'Deployment',
    field: 'deployment_ticket',
    next: STATES.GENERATE_RELEASE_CONTEXT,
    describe: deployDescription,
  },
};

/**
 * Planning state: add a QA/Deployment ticket create step to the draft.
 * Never reuses an existing ticket — every release gets new QA and Deploy tickets.
 */
function planTicket(ctx, kind) {
  const spec = TICKETS[kind];
  const r = ctx.release;
  // Idempotent re-entry: skip only when THIS workflow already created the ticket.
  if (r[spec.field] && createdThisWorkflow(ctx, spec.field)) {
    setState(ctx, spec.next);
    return { continue: true };
  }
  r[spec.field] = null;

  if (!r.development_project || !r.development_issue_type) {
    warn(ctx, `Cannot plan ${spec.label} ticket — missing development project/type; set qa/deploy project and type on the draft`);
    upsertDraftStep(ctx, {
      type: spec.stepType,
      title: spec.title,
      description: `No project/issue type known — revise the draft with the ${spec.label} project and issue type.`,
      skip: true,
      payload: null,
    });
    setState(ctx, spec.next);
    return { continue: true };
  }

  const { issueType, parentKey } = resolveCreateTicketType(r);
  if (/sub[\s-]?task/i.test(String(r.development_issue_type || '')) && issueType === 'Task') {
    warn(ctx, `Dev ticket is a Sub-task without a usable parent — creating ${spec.label} as Task instead`);
  }
  const payload = {
    projectKey: r.development_project,
    issueType,
    parentKey: parentKey || undefined,
    summary: ticketSummary(kind === 'qa' ? 'QA' : 'Deploy', ctx),
    description: spec.describe(ctx),
  };

  upsertDraftStep(ctx, {
    type: spec.stepType,
    title: spec.title,
    description: ticketStepDescription(payload),
    payload,
  });
  audit(ctx, `draft_plan_${kind}`, payload);
  setState(ctx, spec.next);
  return { continue: true, message: `Draft: plan ${spec.label} ${payload.summary}` };
}

const createQaTicket = (ctx) => planTicket(ctx, 'qa');
const createDeploymentTicket = (ctx) => planTicket(ctx, 'deploy');

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
  r.tag_url = `https://github.com/${owner}/${name}/releases/tag/${encodeURIComponent(tag)}`;
  setField(ctx, 'next_version', tag, { confidence: 'high', source: 'github_tag' });
  audit(ctx, 'tag_created', { tag, sha, url: result.url });
  markStepDone(ctx, 'create_tag');
  return {
    text: `Created tag ${tag} on ${repo} @ ${sha}\n${r.tag_url}`,
    result,
  };
}

async function executeCreateTicket(ctx, payload, kind) {
  const spec = TICKETS[kind];
  const jira = createJiraClient();
  let issueType = payload.issueType;
  let parentKey = payload.parentKey;
  // Repair older staged payloads that tried to create a bare Sub-task
  if (/sub[\s-]?task/i.test(String(issueType || '')) && !parentKey) {
    const resolved = resolveCreateTicketType(ctx.release);
    issueType = resolved.issueType;
    parentKey = resolved.parentKey || undefined;
  }
  // Rebuilt at execution time so it reflects earlier steps (e.g. the new QA key).
  const description = payload.description_custom ? payload.description : spec.describe(ctx);
  const created = await jira.createIssue({
    projectKey: payload.projectKey,
    summary: payload.summary,
    issueType,
    description,
    parentKey,
  });
  const key = created.key;
  ctx.release[spec.field] = key;
  setField(ctx, spec.field, key, { confidence: 'high', source: 'jira_create' });
  audit(ctx, `${spec.field}_created`, { key, parentKey: parentKey || null, issueType });
  markStepDone(ctx, spec.stepType);
  return {
    text: `Created ${spec.label} ticket ${key} (${issueType}${parentKey ? `, parent ${parentKey}` : ''})\n${browseUrl(jira.baseUrl, key)}`,
    result: { key, browseUrl: browseUrl(jira.baseUrl, key) },
  };
}

const executeCreateQa = (ctx, payload) => executeCreateTicket(ctx, payload, 'qa');
const executeCreateDeploy = (ctx, payload) => executeCreateTicket(ctx, payload, 'deploy');

module.exports = {
  createQaTicket,
  createDeploymentTicket,
  executeCreateTag,
  executeCreateQa,
  executeCreateDeploy,
};
