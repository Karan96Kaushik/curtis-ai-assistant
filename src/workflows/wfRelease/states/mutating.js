const { createGithubClient, parseRepo } = require('../../../integrations/githubClient');
const { createJiraClient, browseUrl } = require('../../../integrations/jiraClient');
const { setField } = require('../fields');
const { audit, setState, STATES } = require('../context');
const { warn, ticketSummary, resolveCreateTicketType } = require('../helpers');
const { isDraftMode, upsertDraftStep } = require('../draft');

async function createTag(ctx) {
  const r = ctx.release;
  if (r.github_tag_created) {
    setState(ctx, STATES.CREATE_QA_TICKET);
    return { continue: true };
  }

  // If we landed here without executing pending (idempotent re-entry after confirm),
  // the executePending path already created the tag.
  if (ctx._tag_just_created) {
    delete ctx._tag_just_created;
    setState(ctx, STATES.CREATE_QA_TICKET);
    return { continue: true };
  }

  // Re-propose if somehow here without tag
  setState(ctx, STATES.DETERMINE_VERSION);
  return { continue: true };
}

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
  ctx._tag_just_created = true;
  audit(ctx, 'tag_created', { tag, sha, url: result.url });
  ctx.pending_action = null;
  setState(ctx, STATES.CREATE_QA_TICKET);
  return {
    text: `Created tag ${tag} on ${repo} @ ${sha}\n${result.url || result.html_url || ''}`,
    result,
  };
}

async function findExistingTicket(jira, { projectKey, summaryPrefix, version }) {
  if (!projectKey) return null;
  const ver = version || '';
  const jql = `project = ${projectKey} AND summary ~ "${summaryPrefix}" AND summary ~ "${ver}" ORDER BY created DESC`;
  try {
    const { issues } = await jira.searchIssues({
      jql,
      maxResults: 5,
      fields: ['summary', 'status', 'issuetype'],
    });
    return issues?.[0]?.key || null;
  } catch {
    return null;
  }
}

async function createQaTicket(ctx) {
  const r = ctx.release;
  if (r.qa_ticket) {
    setField(ctx, 'qa_ticket', r.qa_ticket, { confidence: 'high', source: 'reuse' });
    setState(ctx, STATES.CREATE_DEPLOYMENT_TICKET);
    return { continue: true };
  }

  const jira = createJiraClient();
  const existing = await findExistingTicket(jira, {
    projectKey: r.development_project,
    summaryPrefix: '[QA]',
    version: r.next_version,
  });
  if (existing) {
    r.qa_ticket = existing;
    setField(ctx, 'qa_ticket', existing, { confidence: 'high', source: 'jira_search' });
    audit(ctx, 'qa_ticket_reused', { key: existing });
    if (isDraftMode(ctx)) {
      upsertDraftStep(ctx, {
        type: 'create_qa_ticket',
        title: 'QA ticket',
        description: `Reuse existing QA ticket ${existing}.`,
        reuse: true,
        reuse_key: existing,
        skip: true,
        payload: null,
      });
    }
    setState(ctx, STATES.CREATE_DEPLOYMENT_TICKET);
    return { continue: true, message: `Reusing existing QA ticket ${existing}` };
  }

  if (!r.development_project || !r.development_issue_type) {
    warn(ctx, 'Cannot create QA ticket — missing development project/type; skipping');
    if (isDraftMode(ctx)) {
      upsertDraftStep(ctx, {
        type: 'create_qa_ticket',
        title: 'QA ticket',
        description: 'Skip QA ticket — missing development project/type.',
        skip: true,
        payload: null,
      });
    }
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

  if (isDraftMode(ctx)) {
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

  ctx.pending_action = { type: 'create_qa_ticket', payload };
  setState(ctx, STATES.WAITING_FOR_CONFIRMATION, { resume: STATES.CREATE_QA_TICKET });
  audit(ctx, 'propose_qa_ticket', payload);

  return {
    pause: 'confirmation',
    pendingArgs: {
      workflowId: ctx.workflow.id,
      type: 'create_qa_ticket',
      payload,
    },
    message: [
      'Create QA ticket?',
      `- Project: ${payload.projectKey}`,
      `- Type: ${payload.issueType}`,
      parentKey ? `- Parent: ${parentKey}` : null,
      `- Summary: ${payload.summary}`,
    ]
      .filter(Boolean)
      .join('\n'),
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
  ctx.pending_action = null;
  audit(ctx, 'qa_ticket_created', { key, parentKey: parentKey || null, issueType });
  setState(ctx, STATES.CREATE_DEPLOYMENT_TICKET);
  return {
    text: `Created QA ticket ${key} (${issueType}${parentKey ? `, parent ${parentKey}` : ''})\n${browseUrl(jira.baseUrl, key)}`,
    result: { key, browseUrl: browseUrl(jira.baseUrl, key) },
  };
}

async function createDeploymentTicket(ctx) {
  const r = ctx.release;
  if (r.deployment_ticket) {
    setField(ctx, 'deployment_ticket', r.deployment_ticket, {
      confidence: 'high',
      source: 'reuse',
    });
    setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
    return { continue: true };
  }

  const jira = createJiraClient();
  const existing = await findExistingTicket(jira, {
    projectKey: r.development_project,
    summaryPrefix: '[Deploy]',
    version: r.next_version,
  });
  if (existing) {
    r.deployment_ticket = existing;
    setField(ctx, 'deployment_ticket', existing, { confidence: 'high', source: 'jira_search' });
    audit(ctx, 'deployment_ticket_reused', { key: existing });
    if (isDraftMode(ctx)) {
      upsertDraftStep(ctx, {
        type: 'create_deployment_ticket',
        title: 'Deployment ticket',
        description: `Reuse existing Deployment ticket ${existing}.`,
        reuse: true,
        reuse_key: existing,
        skip: true,
        payload: null,
      });
    }
    setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
    return { continue: true, message: `Reusing existing Deployment ticket ${existing}` };
  }

  if (!r.development_project || !r.development_issue_type) {
    warn(ctx, 'Cannot create Deployment ticket — missing development project/type; skipping');
    if (isDraftMode(ctx)) {
      upsertDraftStep(ctx, {
        type: 'create_deployment_ticket',
        title: 'Deployment ticket',
        description: 'Skip Deployment ticket — missing development project/type.',
        skip: true,
        payload: null,
      });
    }
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

  if (isDraftMode(ctx)) {
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

  ctx.pending_action = { type: 'create_deployment_ticket', payload };
  setState(ctx, STATES.WAITING_FOR_CONFIRMATION, { resume: STATES.CREATE_DEPLOYMENT_TICKET });
  audit(ctx, 'propose_deployment_ticket', payload);

  return {
    pause: 'confirmation',
    pendingArgs: {
      workflowId: ctx.workflow.id,
      type: 'create_deployment_ticket',
      payload,
    },
    message: [
      'Create Deployment ticket?',
      `- Project: ${payload.projectKey}`,
      `- Type: ${payload.issueType}`,
      parentKey ? `- Parent: ${parentKey}` : null,
      `- Summary: ${payload.summary}`,
    ]
      .filter(Boolean)
      .join('\n'),
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
  ctx.pending_action = null;
  audit(ctx, 'deployment_ticket_created', { key, parentKey: parentKey || null, issueType });
  setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
  return {
    text: `Created Deployment ticket ${key} (${issueType}${parentKey ? `, parent ${parentKey}` : ''})\n${browseUrl(jira.baseUrl, key)}`,
    result: { key, browseUrl: browseUrl(jira.baseUrl, key) },
  };
}

/** Legacy no-op: LINK_JIRA was removed; skip straight to generate. */
async function linkJira(ctx) {
  ctx.pending_action = null;
  audit(ctx, 'link_jira_skipped', { reason: 'step_removed' });
  setState(ctx, STATES.GENERATE_RELEASE_CONTEXT);
  return { continue: true, message: 'Jira linking step skipped (disabled).' };
}

module.exports = {
  createTag,
  createQaTicket,
  createDeploymentTicket,
  linkJira,
  executeCreateTag,
  executeCreateQa,
  executeCreateDeploy,
};