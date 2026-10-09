/**
 * Draft-mode helpers: accumulate planned steps, format the release form, apply edits.
 */

// Reviewer roles from the org's release-form template. Status/comments/date are only ever
// filled from actual review evidence — never fabricated (see release-form-context.txt).
const REVIEW_ROLES = [
  { role: 'Any', name: null },
  { role: 'Dev Lead (Atakan)', name: 'Atakan' },
  { role: 'Functional Lead (Henry)', name: 'Henry' },
  { role: 'Release Lead (Pranab)', name: 'Pranab' },
];

function ensureDraft(ctx) {
  if (!ctx.draft) {
    ctx.draft = { steps: [], notes: [] };
  }
  if (!Array.isArray(ctx.draft.steps)) ctx.draft.steps = [];
  if (!Array.isArray(ctx.draft.notes)) ctx.draft.notes = [];
  return ctx.draft;
}

function isDraftMode(ctx) {
  return ctx?.workflow?.mode === 'draft';
}

function findStep(ctx, type) {
  return ensureDraft(ctx).steps.find((s) => s.type === type) || null;
}

function upsertDraftStep(ctx, step) {
  const draft = ensureDraft(ctx);
  const idx = draft.steps.findIndex((s) => s.type === step.type);
  const entry = {
    type: step.type,
    title: step.title,
    description: step.description,
    payload: step.payload || null,
    skip: Boolean(step.skip),
    // Preserve executed status on re-plan so a retry never repeats a finished write.
    done: Boolean(step.done ?? draft.steps[idx]?.done),
  };
  if (idx >= 0) draft.steps[idx] = entry;
  else draft.steps.push(entry);
  return entry;
}

/** Mark a planned step as executed (write completed). */
function markStepDone(ctx, type) {
  const step = findStep(ctx, type);
  if (step) step.done = true;
  return step;
}

/** Skip / un-skip a planned step. Skipping the tag also records tag_skipped for validation. */
function setStepSkipped(ctx, type, skip) {
  const step = findStep(ctx, type);
  if (!step || step.done) return null;
  step.skip = Boolean(skip);
  if (type === 'create_tag') ctx.release.tag_skipped = Boolean(skip);
  return step;
}

/**
 * Ordered list of remaining writes (skipped and already-executed steps are excluded).
 */
function buildExecutionQueue(ctx) {
  return ensureDraft(ctx)
    .steps.filter((s) => !s.skip && !s.done && s.payload)
    .map((s) => ({ type: s.type, title: s.title, payload: s.payload }));
}

function guessSuffix(entry) {
  return entry?.guess ? ' _(best guess — please verify)_' : '';
}

function fieldText(ctx, key, fallback = '— (needs input)') {
  const entry = ctx.fields?.[key];
  const value = entry?.value ?? ctx.release?.[key];
  if (value == null || value === '' || value === 'Unknown') return fallback;
  return `${value}${guessSuffix(entry)}`;
}

function ticketText(ctx, field, stepType, final) {
  const { jiraLink } = require('./helpers');
  const key = ctx.release?.[field];
  if (key) return jiraLink(key);
  const step = findStep(ctx, stepType);
  if (step?.skip) return '— (skipped)';
  if (!step?.payload) return '— (needs input: no project/issue type to create it in)';
  return final ? '— (not created)' : '— (created on approval)';
}

/**
 * The release form, in the order and with the names used by
 * context/release-form-context.txt. Used for the draft and for the final output.
 * @param {object} ctx
 * @param {{ final?: boolean }} [opts]
 */
function formatReleaseForm(ctx, { final = false } = {}) {
  const { jiraLink } = require('./helpers');
  const r = ctx.release || {};
  const tag = r.next_version;
  const tagState = r.github_tag_created
    ? r.tag_url || 'tag created'
    : r.tag_skipped
      ? 'tag skipped'
      : final
        ? 'tag not created'
        : 'tag created on approval';
  const githubLink = [r.github_link, tagState && tag ? `tag ${tag}: ${tagState}` : null]
    .filter(Boolean)
    .join(' · ');

  const lines = [
    `- **Release #**: ${tag || '— (needs input)'}`,
    `- **Developer**: ${fieldText(ctx, 'developer')}`,
    `- **Component**: ${fieldText(ctx, 'component')}`,
    `- **Release Summary**: ${fieldText(ctx, 'release_summary')}`,
    `- **Product Release - Feature Group**: ${fieldText(ctx, 'feature_group', 'N/A')}`,
    `- **Release Submission Date**: ${fieldText(ctx, 'submission_date')}`,
    `- **Previous release #**: ${fieldText(ctx, 'previous_version', 'None — no previous tag found')}`,
    `- **New release #**: ${tag || '— (needs input)'}`,
    `- **Github link**: ${githubLink || '— (needs input)'}`,
    `- **Jira Task Ref**: ${jiraLink(r.development_ticket) || '— (needs input)'}`,
    `- **QAlity test ref**: ${ticketText(ctx, 'qa_ticket', 'create_qa_ticket', final)}`,
    `- **Jira Task for deployment to prod**: ${ticketText(ctx, 'deployment_ticket', 'create_deployment_ticket', final)}`,
    `- **Changes to software stack**: ${fieldText(ctx, 'software_stack_changes', 'N/A')}`,
    `- **Snyk security issues**: ${fieldText(ctx, 'snyk_security')}`,
    `- **Release risks**: ${fieldText(ctx, 'risk')}`,
    `- **Release rollback / backout plan**: ${fieldText(ctx, 'rollback_plan')}`,
    `- **Potential to contact the customer directly**: ${fieldText(ctx, 'customer_impact', 'N/A')}`,
    `- **Release security**: ${fieldText(ctx, 'security', 'N/A')}`,
    `- **Post-release monitoring**: ${fieldText(ctx, 'monitoring_owner')}`,
    '',
    '**Review** — status, comments and date are filled only by the actual reviewers:',
    ...REVIEW_ROLES.map(
      (rev) =>
        `- **${rev.role}** — Reviewer Name: ${rev.name ? `${rev.name} _(best guess from role)_` : '—'} · Status: Pending · Review Comments: — · Review Date: —`
    ),
  ];
  return lines.join('\n');
}

/** Bullet details of one planned step (tag / ticket payload). */
function formatStepDetails(step) {
  const lines = [];
  const p = step.payload;
  if (!p) return lines;
  if (step.type === 'create_tag') {
    if (p.tag) lines.push(`- Tag: \`${p.tag}\``);
    if (p.sha) lines.push(`- Commit: \`${p.sha}\``);
    if (p.message) lines.push(`- Annotation: ${p.message}`);
    return lines;
  }
  if (p.summary) lines.push(`- Summary: ${p.summary}`);
  if (p.projectKey) lines.push(`- Project: ${p.projectKey} (${p.issueType || '?'})`);
  if (p.parentKey) lines.push(`- Parent: ${p.parentKey}`);
  if (p.description) {
    lines.push(p.description_custom ? '- Ticket body (custom):' : '- Ticket body (refreshed when created):');
    for (const bodyLine of String(p.description).split('\n')) lines.push(`  ${bodyLine}`);
  }
  return lines;
}

function formatDraft(ctx) {
  const r = ctx.release || {};
  const draft = ensureDraft(ctx);

  const lines = [
    `# Release draft — ${ctx.workflow.id}`,
    '',
    '## Release form',
    formatReleaseForm(ctx),
    '',
    '### Technical summary (internal — not a release-form field)',
    fieldText(ctx, 'technical_summary', '—'),
    '',
    '## Source',
    `- Repository: ${r.repository || '—'}`,
    `- PR: ${r.source_pr != null ? `#${r.source_pr}` : '—'} ${r.pr_title ? `(${r.pr_title})` : ''}`,
    `- Branch: ${r.source_branch || '—'}`,
    `- Merge commit: ${r.merge_commit || '—'}`,
    `- Jira project: ${r.development_project || '—'}`,
    `- CI: ${r.ci_status || 'unknown'} | PR merged: ${r.pr_merged == null ? 'unknown' : r.pr_merged}`,
    '',
    '## Planned steps',
  ];

  if (!draft.steps.length) {
    lines.push('(no mutating steps planned)');
  } else {
    draft.steps.forEach((step, i) => {
      lines.push('', `### ${i + 1}. ${step.title}`, step.description || '(no description)');
      if (!step.skip) lines.push(...formatStepDetails(step));
      if (step.done) lines.push('_Action: already executed ✓_');
      else if (step.skip) lines.push('_Action: skip (no write)_');
      else lines.push('_Action: runs after approval_');
    });
  }

  if (ctx.warnings?.length) {
    lines.push('', '## Warnings');
    for (const w of ctx.warnings) lines.push(`- ${w}`);
  }

  lines.push(
    '',
    '## How to proceed',
    '- Ask for any changes (tag, commit, QA/Deploy title/project/type/parent/body, any form field, or "regenerate with: <extra context>").',
    '- Approve to run the writes one at a time — each step waits for your confirm, skip, or edit.',
    '- Or "approve and run all" to run every write without stopping.',
    `- Workflow id: \`${ctx.workflow.id}\``
  );

  return lines.join('\n');
}

/** Prompt shown when a single step is staged for confirmation. */
function formatStepPrompt(ctx, step) {
  const active = ensureDraft(ctx).steps.filter((s) => s.payload);
  const position = active.findIndex((s) => s.type === step.type) + 1;
  const current = findStep(ctx, step.type) || step;
  return [
    `**Step ${position} of ${active.length} — ${current.title}**`,
    current.description || '',
    ...formatStepDetails(current),
    '',
    'Reply **confirm** to run this step, **skip** to skip it, ask for changes to edit it first, **run all remaining** to finish without stopping, or **cancel** to return to the draft.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function present(v) {
  return v != null && String(v).trim() !== '';
}

/** Keep generated ticket titles/bodies in sync with version/component edits. */
function syncTicketSteps(ctx) {
  const { ticketSummary, qaDescription, deployDescription, ticketStepDescription } = require('./helpers');
  for (const [type, prefix, describe] of [
    ['create_qa_ticket', 'QA', qaDescription],
    ['create_deployment_ticket', 'Deploy', deployDescription],
  ]) {
    const step = findStep(ctx, type);
    if (!step?.payload || step.done) continue;
    if (!step.payload.summary_custom) step.payload.summary = ticketSummary(prefix, ctx);
    if (!step.payload.description_custom) step.payload.description = describe(ctx);
    step.description = ticketStepDescription(step.payload);
  }
}

function editTicketStep(ctx, type, edits, ignored) {
  const { ticketStepDescription } = require('./helpers');
  const label = type === 'create_qa_ticket' ? 'QA ticket' : 'Deployment ticket';
  const wantsEdit = ['summary', 'project', 'issue_type', 'parent', 'description'].some((k) => present(edits[k]));
  if (!wantsEdit && edits.skip == null) return;

  const step = findStep(ctx, type);
  if (step?.done) {
    ignored.push(`${label} already created — edit it in Jira instead.`);
    return;
  }
  if (!step) {
    ignored.push(`${label}: no planned step to edit.`);
    return;
  }
  if (!step.payload && wantsEdit) {
    step.payload = {
      projectKey: null,
      issueType: 'Task',
      summary: null,
    };
  }
  const p = step.payload;
  if (p) {
    if (present(edits.summary)) {
      p.summary = String(edits.summary).trim();
      p.summary_custom = true;
    }
    if (present(edits.project)) p.projectKey = String(edits.project).trim().toUpperCase();
    if (present(edits.issue_type)) p.issueType = String(edits.issue_type).trim();
    if (present(edits.parent)) {
      const parent = String(edits.parent).trim();
      p.parentKey = /^(none|no|clear|-)$/i.test(parent) ? undefined : parent.toUpperCase();
    }
    if (present(edits.description)) {
      p.description = String(edits.description).trim();
      p.description_custom = true;
    }
    if (!p.projectKey) ignored.push(`${label}: still needs a project key before it can be created.`);
  }
  if (edits.skip != null) step.skip = Boolean(edits.skip);
  else if (wantsEdit) step.skip = !p?.projectKey;
  if (p?.projectKey && p.summary) step.description = ticketStepDescription(p);
}

function editTagStep(ctx, patch, ignored) {
  const { tagStepDescription } = require('./helpers');
  const { setField } = require('./fields');
  const r = ctx.release;
  const skipTag = patch.skip_tag ?? patch.skipTag;
  const wantsEdit = present(patch.tag) || present(patch.message) || present(patch.tag_sha);
  if (!wantsEdit && skipTag == null) return;

  const step = findStep(ctx, 'create_tag');
  if (step?.done) {
    ignored.push('Tag already created — it cannot be changed from here.');
    return;
  }

  const p = {
    repo: r.repository,
    tag: r.next_version,
    sha: r.merge_commit,
    message: `Release ${r.next_version}`,
    previous_version: r.previous_version,
    ...(step?.payload || {}),
  };
  if (present(patch.tag)) {
    const tag = String(patch.tag).trim();
    if (!p.message || /^Release\s+/i.test(p.message)) p.message = `Release ${tag}`;
    p.tag = tag;
    setField(ctx, 'next_version', tag, { confidence: 'high', source: 'user_draft_edit' });
  }
  if (present(patch.message)) p.message = String(patch.message).trim();
  if (present(patch.tag_sha)) {
    p.sha = String(patch.tag_sha).trim();
    setField(ctx, 'merge_commit', p.sha, { confidence: 'high', source: 'user_draft_edit' });
  }
  p.previous_version = r.previous_version;

  const skip = skipTag != null ? Boolean(skipTag) : wantsEdit ? false : Boolean(step?.skip);
  r.tag_skipped = skip;
  upsertDraftStep(ctx, {
    type: 'create_tag',
    title: 'Create Git tag',
    description: skip
      ? `Skip creating a Git tag. Version ${r.next_version || 'TBD'} is still used for ticket titles.`
      : tagStepDescription(p),
    payload: p,
    skip,
  });
}

const FIELD_PATCHES = [
  'release_summary',
  'technical_summary',
  'feature_group',
  'software_stack_changes',
  'snyk_security',
  'rollback_plan',
  'risk',
  'security',
  'customer_impact',
  'monitoring_owner',
  'github_link',
  'developer',
  'component',
  'submission_date',
  'previous_version',
];

/**
 * Apply user edits to the draft + release context and rebuild step payloads.
 * Accepts draft tool fields and older revise_pending aliases (summary, skipTag, …).
 * @returns {{ ignored: string[] }} edits that could not be applied (e.g. step already ran)
 */
function applyDraftEdits(ctx, patch = {}) {
  const ignored = [];

  // Bare `summary` from revise_pending → QA title unless deploy was named
  let qaSummary = patch.qa_summary ?? patch.qaSummary;
  const deploySummary = patch.deploy_summary ?? patch.deploySummary;
  if (present(patch.summary) && qaSummary == null && deploySummary == null) {
    qaSummary = String(patch.summary).trim();
  }

  const { setField } = require('./fields');
  for (const key of FIELD_PATCHES) {
    if (present(patch[key])) {
      setField(ctx, key, String(patch[key]).trim(), { confidence: 'high', source: 'user_draft_edit' });
    }
  }

  editTagStep(ctx, patch, ignored);
  const tagStep = findStep(ctx, 'create_tag');
  if (present(patch.previous_version) && tagStep?.payload && !tagStep.done) {
    const { tagStepDescription } = require('./helpers');
    tagStep.payload.previous_version = ctx.release.previous_version;
    if (!tagStep.skip) tagStep.description = tagStepDescription(tagStep.payload);
  }
  editTicketStep(
    ctx,
    'create_qa_ticket',
    {
      summary: qaSummary,
      project: patch.qa_project,
      issue_type: patch.qa_issue_type,
      parent: patch.qa_parent,
      description: patch.qa_description,
      skip: patch.skip_qa,
    },
    ignored
  );
  editTicketStep(
    ctx,
    'create_deployment_ticket',
    {
      summary: deploySummary,
      project: patch.deploy_project,
      issue_type: patch.deploy_issue_type,
      parent: patch.deploy_parent,
      description: patch.deploy_description,
      skip: patch.skip_deploy,
    },
    ignored
  );
  syncTicketSteps(ctx);

  return { ignored };
}

module.exports = {
  REVIEW_ROLES,
  ensureDraft,
  isDraftMode,
  findStep,
  upsertDraftStep,
  markStepDone,
  setStepSkipped,
  formatReleaseForm,
  formatDraft,
  formatStepPrompt,
  applyDraftEdits,
  buildExecutionQueue,
};
