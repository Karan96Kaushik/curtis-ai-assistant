const fs = require('fs');
const path = require('path');
const { chat } = require('../../../integrations/groqClient');
const { setField, markUnknown, markSkipped, listUnresolved, formatFieldReview, FIELD_KEYS } =
  require('../fields');
const { audit, setState, STATES } = require('../context');
const { warn } = require('../helpers');
const store = require('../store');
const { isDraftMode, formatDraft } = require('../draft');

async function generateReleaseContext(ctx) {
  const r = ctx.release;
  const evidence = {
    repository: r.repository,
    component: r.component,
    pr: r.source_pr,
    pr_title: r.pr_title,
    pr_body: (r.pr_body || '').slice(0, 2000),
    commits: (r.commits || []).slice(0, 20).map((c) => c.message?.split('\n')[0]),
    developer: r.developer,
    development_ticket: r.development_ticket,
    jira_summary: ctx._jira_dev_summary,
    previous_version: r.previous_version,
    next_version: r.next_version,
    changed_files: (r.changed_files || []).slice(0, 40),
  };

  let generated = null;
  try {
    const { message } = await chat({
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'You write release checklist fields from evidence only. Reply with JSON only: ' +
            '{"release_summary","technical_summary","rollback_plan","risk","security","customer_impact","monitoring_owner"}. ' +
            'Use null for unknowns. Do not invent ticket keys, versions, or URLs.',
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
      setField(ctx, key, r[key], { confidence: 'high', source: 'context' });
    }
  }

  audit(ctx, 'generate_release_context');
  setState(ctx, STATES.RESOLVE_UNKNOWN_FIELDS);
  return { continue: true };
}

async function resolveUnknownFields(ctx) {
  const unresolved = listUnresolved(ctx);
  ctx.unknown_fields = unresolved;

  // Draft mode: don't block on one-by-one questions — surface unknowns in the draft
  if (isDraftMode(ctx)) {
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

  if (!unresolved.length) {
    setState(ctx, STATES.REVIEW_RELEASE);
    return {
      pause: 'review',
      message: formatReviewMessage(ctx),
    };
  }

  const field = unresolved[0];
  const suggestion = ctx.fields?.[field]?.value;
  const prompts = {
    rollback_plan: `Suggested rollback: ${suggestion && suggestion !== 'Unknown' ? suggestion : `Redeploy ${ctx.release.previous_version || 'previous tag'}`} — Accept, provide value, or skip?`,
    risk: `Suggested risk: ${suggestion && suggestion !== 'Unknown' ? suggestion : 'Low'} — Accept, provide value, or skip?`,
    security: 'Security notes unknown. Provide value or skip?',
    customer_impact: 'Customer impact unknown. Provide value or skip?',
    monitoring_owner: `Monitoring owner? Suggested: ${ctx.release.developer || 'n/a'} — Accept, provide, or skip?`,
    release_summary: 'Release summary missing. Provide text or skip?',
    technical_summary: 'Technical summary missing. Provide text or skip?',
  };

  ctx.user_prompt = {
    field,
    prompt: prompts[field] || `${field} is unknown. Provide a value or skip.`,
    suggestion: suggestion && suggestion !== 'Unknown' ? suggestion : null,
  };

  audit(ctx, 'ask_unknown_field', { field });
  return {
    pause: 'user_input',
    question: ctx.user_prompt,
    message: ctx.user_prompt.prompt,
  };
}

async function draftReview(ctx) {
  setState(ctx, STATES.DRAFT_REVIEW);
  return {
    pause: 'draft',
    message: formatDraft(ctx),
  };
}

function formatReviewMessage(ctx) {
  return [
    `Release review — workflow ${ctx.workflow.id}`,
    `State: ${ctx.workflow.state}`,
    '',
    formatFieldReview(ctx),
    '',
    ctx.warnings?.length ? `Warnings:\n${ctx.warnings.map((w) => `- ${w}`).join('\n')}` : '',
    '',
    'Edit fields with wf_release_edit, or approve with wf_release_approve_review.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function reviewRelease(ctx) {
  if (isDraftMode(ctx)) {
    return draftReview(ctx);
  }
  setState(ctx, STATES.REVIEW_RELEASE);
  return {
    pause: 'review',
    message: formatReviewMessage(ctx),
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

async function exportArtifacts(ctx) {
  const r = ctx.release;
  const dir = store.RELEASES_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const checklist = [
    '# Release Checklist',
    '',
    ...FIELD_KEYS.map((key) => {
      const entry = ctx.fields?.[key];
      const value = entry?.value ?? r[key] ?? 'Unknown';
      return `- **${key}**: ${value} _(confidence=${entry?.confidence || '?'}, source=${entry?.source || '?'})_`;
    }),
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
    '## Customer impact',
    r.customer_impact || 'n/a',
    '',
    `Repository: ${r.repository}`,
    `Tag: ${r.next_version}`,
    `PR: ${r.source_pr || 'n/a'}`,
    `Dev: ${r.development_ticket || 'n/a'}`,
    `QA: ${r.qa_ticket || 'n/a'}`,
    `Deploy: ${r.deployment_ticket || 'n/a'}`,
  ].join('\n');

  const deploymentSummary = [
    `# Deployment Summary — ${r.next_version || 'TBD'}`,
    '',
    `Rollback: ${r.rollback_plan || 'n/a'}`,
    `Risk: ${r.risk || 'n/a'}`,
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
      `QA: ${r.qa_ticket || 'n/a'}`,
      `Deploy: ${r.deployment_ticket || 'n/a'}`,
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
  resolveUnknownFields,
  reviewRelease,
  draftReview,
  validate,
  exportArtifacts,
  recover,
  formatReviewMessage,
  markSkipped,
  setField,
  listUnresolved,
};
