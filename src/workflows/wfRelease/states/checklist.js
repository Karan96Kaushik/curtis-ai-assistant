const fs = require('fs');
const path = require('path');
const { chat } = require('../../../integrations/aiRouter');
const { setField, markUnknown, listUnresolved, FIELD_KEYS } = require('../fields');
const { audit, setState, STATES } = require('../context');
const { warn, jiraLink } = require('../helpers');
const store = require('../store');
const { formatDraft } = require('../draft');

// Release-form generation spec (field definitions + rules for the LLM). Loaded once and
// injected into the checklist-generation system prompt so the draft follows the org's
// actual release-form conventions instead of a generic summary.
const RELEASE_FORM_CONTEXT_PATH = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'context',
  'release-form-context.txt'
);
let releaseFormContextCache = null;
function loadReleaseFormContext() {
  if (releaseFormContextCache != null) return releaseFormContextCache;
  try {
    releaseFormContextCache = fs.readFileSync(RELEASE_FORM_CONTEXT_PATH, 'utf8');
  } catch (err) {
    releaseFormContextCache = '';
  }
  return releaseFormContextCache;
}

async function generateReleaseContext(ctx) {
  const r = ctx.release;

  // Release Submission Date is deterministic — set once, not LLM-generated.
  if (!r.submission_date) {
    r.submission_date = new Date().toISOString().slice(0, 10);
  }
  setField(ctx, 'submission_date', r.submission_date, { confidence: 'high', source: 'system' });
  if (r.github_link) {
    setField(ctx, 'github_link', r.github_link, { confidence: 'high', source: 'github' });
  }

  // Gather ALL available context in one shot so the LLM can populate the entire
  // draft's checklist/release-form fields together, instead of asking field-by-field.
  const evidence = {
    repository: r.repository,
    component: r.component,
    github_link: r.github_link,
    pr: r.source_pr,
    pr_title: r.pr_title,
    pr_body: (r.pr_body || '').slice(0, 2000),
    pr_merged: r.pr_merged,
    ci_status: r.ci_status,
    reviewers: r.reviewers,
    commits: (r.commits || []).slice(0, 20).map((c) => c.message?.split('\n')[0]),
    changed_files: (r.changed_files || []).slice(0, 40),
    developer: r.developer,
    development_ticket: r.development_ticket,
    development_issue_type: r.development_issue_type,
    jira_summary: ctx._jira_dev_summary,
    jira_description: (ctx._jira_dev_description || '').slice(0, 1500),
    jira_status: ctx._jira_dev_status,
    previous_version: r.previous_version,
    next_version: r.next_version,
    version_bump: r.version_bump,
    version_reason: r.version_reason,
    tag_skipped: r.tag_skipped,
    qa_ticket: r.qa_ticket,
    deployment_ticket: r.deployment_ticket,
    warnings: ctx.warnings,
  };

  let generated = null;
  try {
    const formSpec = loadReleaseFormContext();
    const { message } = await chat({
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: [
            'You are drafting a complete release plan/form. Given ALL of the context evidence below at once',
            '(PR, Jira, commits, files, CI, version), write every release-form field in a single pass,',
            'following the field definitions and generation rules in the release form specification below.',
            '',
            formSpec ? `RELEASE FORM SPECIFICATION:\n${formSpec.slice(0, 6000)}` : '',
            '',
            'Reply with JSON only: {"release_summary","technical_summary","feature_group",' +
              '"software_stack_changes","snyk_security","rollback_plan","risk","security","customer_impact","monitoring_owner"}.',
            'Use null when genuinely unknown or not applicable — the caller will substitute "N/A" or flag it for a human.',
            'Do not invent ticket keys, versions, URLs, security-scan results, or approvals — use only the evidence given.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(evidence, null, 2),
        },
      ],
    });
    const raw = message?.content || '';
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) generated = JSON.parse(jsonMatch[0]);
  } catch (err) {
    warn(ctx, `LLM release summary failed: ${err.message}`);
  }

  const defaults = {
    release_summary:
      generated?.release_summary ||
      `Release ${r.next_version || ''} for ${r.component || r.repository || 'component'}: ${r.pr_title || ctx._jira_dev_summary || 'see linked PR/Jira'}`.trim(),
    technical_summary:
      generated?.technical_summary ||
      (r.commits?.length
        ? r.commits
            .slice(0, 8)
            .map((c) => `- ${c.message?.split('\n')[0]}`)
            .join('\n')
        : null),
    feature_group: generated?.feature_group || 'N/A',
    software_stack_changes: generated?.software_stack_changes || 'N/A',
    // No Snyk integration exists yet — never let the LLM guess a scan result.
    snyk_security:
      generated?.snyk_security ||
      'Not verified — no Snyk scan data available; manual check required before release.',
    rollback_plan:
      generated?.rollback_plan ||
      (r.previous_version ? `Redeploy ${r.previous_version}` : null),
    risk: generated?.risk || 'Low — standard release',
    security: generated?.security || null,
    customer_impact: generated?.customer_impact || null,
    monitoring_owner: generated?.monitoring_owner || r.developer || null,
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (value != null && value !== '') {
      setField(ctx, key, value, {
        confidence: generated?.[key] ? 'medium' : 'low',
        source: generated?.[key] ? 'llm' : 'heuristic',
      });
    } else {
      markUnknown(ctx, key);
    }
  }

  // Sync known release fields into fields map
  for (const key of [
    'repository',
    'component',
    'developer',
    'github_link',
    'submission_date',
    'source_pr',
    'source_branch',
    'merge_commit',
    'previous_version',
    'next_version',
    'development_ticket',
    'qa_ticket',
    'deployment_ticket',
  ]) {
    if (r[key] != null && r[key] !== '') {
      // Don't overwrite a key this workflow already created in Jira.
      if (ctx.fields?.[key]?.source === 'jira_create') continue;
      setField(ctx, key, r[key], { confidence: 'high', source: 'context' });
    }
  }

  audit(ctx, 'generate_release_context');

  // Surface unresolved fields in the draft instead of asking one by one —
  // the user fixes them via wf_release_revise_draft during review.
  const unresolved = listUnresolved(ctx);
  ctx.unknown_fields = unresolved;
  for (const key of unresolved) {
    if (!ctx.fields?.[key] || ctx.fields[key].source === 'unknown') {
      markUnknown(ctx, key);
    }
  }
  setState(ctx, STATES.DRAFT_REVIEW);
  audit(ctx, 'draft_ready');
  return {
    pause: 'draft',
    message: formatDraft(ctx),
  };
}

async function draftReview(ctx) {
  setState(ctx, STATES.DRAFT_REVIEW);
  return {
    pause: 'draft',
    message: formatDraft(ctx),
  };
}

async function validate(ctx) {
  const r = ctx.release;
  const warnings = [];

  if (r.source_pr && r.pr_merged === false) warnings.push('PR is not merged');
  if (r.ci_status && r.ci_status !== 'success' && r.ci_status !== 'passing') {
    warnings.push(`CI status: ${r.ci_status}`);
  }
  if (!r.ci_status) warnings.push('CI status unknown');
  if (!r.github_tag_created || !r.next_version) {
    warnings.push(r.tag_skipped ? 'Git tag skipped by user' : 'Git tag missing');
  }
  if (!r.qa_ticket) warnings.push('QA ticket missing');
  if (!r.deployment_ticket) warnings.push('Deployment ticket missing');
  if (!r.development_ticket) warnings.push('Development ticket missing');

  for (const w of warnings) warn(ctx, w);

  const hardMissing =
    !r.tag_skipped && (!r.github_tag_created || !r.next_version);
  if (r.tag_skipped && !r.github_tag_created) {
    warn(ctx, 'Git tag was skipped by user');
  }
  audit(ctx, 'validated', { warnings: ctx.warnings, hardMissing });

  if (hardMissing) {
    return {
      pause: 'user_input',
      message: `Validation blocked: git tag required before export.\nWarnings:\n${(ctx.warnings || []).map((w) => `- ${w}`).join('\n')}`,
    };
  }

  setState(ctx, STATES.EXPORT);
  return { continue: true, message: `Validation passed with ${(ctx.warnings || []).length} warning(s).` };
}

// Reviewer roles from the org's release-form template. Status/comments/date/name are only
// ever filled from actual review evidence — never fabricated (see release-form-context.txt).
const REVIEW_ROLES = [
  { role: 'Any' },
  { role: 'Dev Lead (Atakan)' },
  { role: 'Functional Lead (Henry)' },
  { role: 'Release Lead (Pranab)' },
];

async function exportArtifacts(ctx) {
  const r = ctx.release;
  const dir = store.RELEASES_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const checklist = [
    '# Release Checklist',
    '',
    ...FIELD_KEYS.map((key) => {
      const entry = ctx.fields?.[key];
      let value = entry?.value ?? r[key] ?? 'Unknown';
      if (
        ['development_ticket', 'qa_ticket', 'deployment_ticket'].includes(key) &&
        value &&
        value !== 'Unknown'
      ) {
        value = jiraLink(value);
      }
      return `- **${key}**: ${value} _(confidence=${entry?.confidence || '?'}, source=${entry?.source || '?'})_`;
    }),
    '',
    '## Review metadata',
    '_Status/comments/date/name are left blank unless there is actual reviewer evidence — never fabricated._',
    ...REVIEW_ROLES.map((rev) => `- **${rev.role}**: Status=Pending, Reviewer Name=—, Comments=—, Date=—`),
    '',
    '## Warnings',
    ...(ctx.warnings || []).map((w) => `- ${w}`),
    '',
  ].join('\n');

  const releaseNotes = [
    `# Release Notes — ${r.next_version || 'TBD'}`,
    '',
    r.release_summary || '',
    '',
    '## Technical',
    r.technical_summary || '',
    '',
    '## Software stack changes',
    r.software_stack_changes || 'N/A',
    '',
    '## Customer impact',
    r.customer_impact || 'n/a',
    '',
    `Component: ${r.component || 'n/a'}`,
    `Feature group: ${r.feature_group || 'N/A'}`,
    `Repository: ${r.repository}`,
    `GitHub: ${r.github_link || 'n/a'}`,
    `Tag: ${r.next_version}`,
    `PR: ${r.source_pr || 'n/a'}`,
    `Dev: ${jiraLink(r.development_ticket) || 'n/a'}`,
    `QA: ${jiraLink(r.qa_ticket) || 'n/a'}`,
    `Deploy: ${jiraLink(r.deployment_ticket) || 'n/a'}`,
    `Submitted: ${r.submission_date || 'n/a'}`,
  ].join('\n');

  const deploymentSummary = [
    `# Deployment Summary — ${r.next_version || 'TBD'}`,
    '',
    `Rollback: ${r.rollback_plan || 'n/a'}`,
    `Risk: ${r.risk || 'n/a'}`,
    `Release security: ${r.security || 'n/a'}`,
    `Snyk security: ${r.snyk_security || 'n/a'}`,
    `Monitoring owner: ${r.monitoring_owner || 'n/a'}`,
    `Merge commit: ${r.merge_commit || 'n/a'}`,
    `CI: ${r.ci_status || 'unknown'}`,
  ].join('\n');

  const base = path.join(dir, ctx.workflow.id);
  const paths = {
    checklist: `${base}-checklist.md`,
    releaseNotes: `${base}-release-notes.md`,
    deployment: `${base}-deployment.md`,
    context: path.join(dir, `${ctx.workflow.id}.json`),
  };

  fs.writeFileSync(paths.checklist, checklist, 'utf8');
  fs.writeFileSync(paths.releaseNotes, releaseNotes, 'utf8');
  fs.writeFileSync(paths.deployment, deploymentSummary, 'utf8');

  r.checklist_complete = true;
  ctx.export_paths = paths;
  audit(ctx, 'exported', { paths });
  setState(ctx, STATES.COMPLETE);
  store.write(ctx);

  return {
    pause: 'complete',
    message: [
      `Release workflow complete: ${ctx.workflow.id}`,
      `Tag: ${r.next_version}`,
      `Dev: ${jiraLink(r.development_ticket) || 'n/a'}`,
      `QA: ${jiraLink(r.qa_ticket) || 'n/a'}`,
      `Deploy: ${jiraLink(r.deployment_ticket) || 'n/a'}`,
      '',
      'Artifacts:',
      `- ${paths.checklist}`,
      `- ${paths.releaseNotes}`,
      `- ${paths.deployment}`,
      '',
      checklist.slice(0, 3500),
    ].join('\n'),
    done: true,
  };
}

async function recover(ctx) {
  const err = ctx._last_error;
  const retries = (ctx._recover_retries || 0) + 1;
  ctx._recover_retries = retries;
  const resume = ctx.workflow.resume_state || ctx.workflow.previous_state || STATES.IDENTIFY_SOURCE;

  if (retries <= 1 && err) {
    audit(ctx, 'recover_retry', { resume, attempt: retries });
    setState(ctx, resume);
    return { continue: true, message: `Retrying ${resume} after failure…` };
  }

  return {
    pause: 'user_input',
    message: [
      `Recovery needed after failure in ${err?.tool || 'unknown'}:`,
      err?.reason || 'unknown error',
      '',
      `Resume state would be: ${resume}`,
      'Fix the issue and call wf_release_status / restart, or skip optional steps.',
    ].join('\n'),
  };
}

module.exports = {
  generateReleaseContext,
  draftReview,
  validate,
  exportArtifacts,
  recover,
};
