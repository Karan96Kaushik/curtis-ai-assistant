const STATES = {
  START: 'START',
  IDENTIFY_SOURCE: 'IDENTIFY_SOURCE',
  READ_GITHUB: 'READ_GITHUB',
  READ_JIRA: 'READ_JIRA',
  DETERMINE_VERSION: 'DETERMINE_VERSION',
  CREATE_TAG: 'CREATE_TAG',
  CREATE_QA_TICKET: 'CREATE_QA_TICKET',
  CREATE_DEPLOYMENT_TICKET: 'CREATE_DEPLOYMENT_TICKET',
  LINK_JIRA: 'LINK_JIRA',
  GENERATE_RELEASE_CONTEXT: 'GENERATE_RELEASE_CONTEXT',
  RESOLVE_UNKNOWN_FIELDS: 'RESOLVE_UNKNOWN_FIELDS',
  REVIEW_RELEASE: 'REVIEW_RELEASE',
  VALIDATE: 'VALIDATE',
  EXPORT: 'EXPORT',
  COMPLETE: 'COMPLETE',
  DRAFT_REVIEW: 'DRAFT_REVIEW',
  WAITING_FOR_CONFIRMATION: 'WAITING_FOR_CONFIRMATION',
  FAILED: 'FAILED',
  RECOVER: 'RECOVER',
};

/** Auto-advancing states (no user pause unless they return pause). */
const AUTO_STATES = new Set([
  STATES.START,
  STATES.IDENTIFY_SOURCE,
  STATES.READ_GITHUB,
  STATES.READ_JIRA,
  STATES.CREATE_TAG,
  STATES.CREATE_QA_TICKET,
  STATES.CREATE_DEPLOYMENT_TICKET,
  STATES.LINK_JIRA,
  STATES.GENERATE_RELEASE_CONTEXT,
  STATES.VALIDATE,
  STATES.EXPORT,
  STATES.RECOVER,
]);

function newId() {
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {{ repository?: string, source_pr?: number|string, source_branch?: string, development_ticket?: string }} seed
 */
function createReleaseContext(seed = {}) {
  const now = new Date().toISOString();
  return {
    workflow: {
      id: newId(),
      state: STATES.START,
      previous_state: null,
      started_at: now,
      updated_at: now,
      resume_state: null,
      mode: 'step', // 'step' | 'draft'
    },
    release: {
      repository: seed.repository || null,
      component: null,
      source_pr: seed.source_pr != null ? Number(seed.source_pr) || seed.source_pr : null,
      source_branch: seed.source_branch || null,
      merge_commit: null,
      developer: null,
      development_ticket: seed.development_ticket || null,
      development_project: null,
      development_issue_type: null,
      development_parent_key: null,
      qa_ticket: null,
      deployment_ticket: null,
      previous_version: null,
      next_version: null,
      github_tag_created: false,
      release_summary: null,
      technical_summary: null,
      rollback_plan: null,
      risk: null,
      security: null,
      customer_impact: null,
      monitoring_owner: null,
      checklist_complete: false,
      pr_merged: null,
      ci_status: null,
      pr_title: null,
      pr_body: null,
      reviewers: [],
      commits: [],
      changed_files: [],
      version_bump: null,
      version_reason: null,
      tag_skipped: false,
    },
    fields: {},
    draft: { steps: [], notes: [] },
    pending_action: null,
    unknown_fields: [],
    warnings: [],
    audit_log: [],
    user_prompt: null,
    export_paths: null,
  };
}

function audit(ctx, event, detail = {}) {
  ctx.audit_log = ctx.audit_log || [];
  ctx.audit_log.push({
    at: new Date().toISOString(),
    state: ctx.workflow?.state,
    event,
    ...detail,
  });
  return ctx;
}

function setState(ctx, next, { resume = null } = {}) {
  ctx.workflow.previous_state = ctx.workflow.state;
  ctx.workflow.state = next;
  if (resume !== undefined) ctx.workflow.resume_state = resume;
  return ctx;
}

module.exports = {
  STATES,
  AUTO_STATES,
  newId,
  createReleaseContext,
  audit,
  setState,
};
