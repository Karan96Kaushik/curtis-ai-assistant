/**
 * Draft-mode helpers: accumulate planned steps, format for review, apply edits.
 */

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

function upsertDraftStep(ctx, step) {
  const draft = ensureDraft(ctx);
  const idx = draft.steps.findIndex((s) => s.type === step.type);
  const entry = {
    type: step.type,
    title: step.title,
    description: step.description,
    payload: step.payload || null,
    skip: Boolean(step.skip),
    reuse: Boolean(step.reuse),
    reuse_key: step.reuse_key || null,
  };
  if (idx >= 0) draft.steps[idx] = entry;
  else draft.steps.push(entry);
  return entry;
}

function formatDraft(ctx) {
  const r = ctx.release || {};
  const draft = ensureDraft(ctx);
  const lines = [
    `# Release draft — ${ctx.workflow.id}`,
    '',
    '## Source',
    `- Repository: ${r.repository || '—'}`,
    `- PR: ${r.source_pr != null ? `#${r.source_pr}` : '—'} ${r.pr_title ? `(${r.pr_title})` : ''}`,
    `- Branch: ${r.source_branch || '—'}`,
    `- Merge commit: ${r.merge_commit || '—'}`,
    `- Developer: ${r.developer || '—'}`,
    `- Development Jira: ${r.development_ticket || '—'} (${r.development_issue_type || '?'})`,
    `- Project: ${r.development_project || '—'}`,
    `- CI: ${r.ci_status || 'unknown'} | PR merged: ${r.pr_merged == null ? 'unknown' : r.pr_merged}`,
    '',
    '## Planned steps',
  ];

  if (!draft.steps.length) {
    lines.push('(no mutating steps planned)');
  } else {
    draft.steps.forEach((step, i) => {
      lines.push('');
      lines.push(`### ${i + 1}. ${step.title}`);
      lines.push(step.description);
      if (step.skip) lines.push('_Action: skip (no write)_');
      else if (step.reuse) lines.push(`_Action: reuse existing ${step.reuse_key}_`);
      else lines.push('_Action: will create/write on approval_');
    });
  }

  lines.push('', '## Checklist fields');
  const checklistKeys = [
    'release_summary',
    'technical_summary',
    'rollback_plan',
    'risk',
    'security',
    'customer_impact',
    'monitoring_owner',
  ];
  for (const key of checklistKeys) {
    const entry = ctx.fields?.[key];
    const value = entry?.value ?? r[key] ?? 'Unknown';
    lines.push(`- **${key}**: ${value}`);
  }

  if (ctx.warnings?.length) {
    lines.push('', '## Warnings');
    for (const w of ctx.warnings) lines.push(`- ${w}`);
  }

  lines.push(
    '',
    '## How to proceed',
    '- Approve this draft to execute all create steps in one go (after confirmation).',
    '- Or ask for changes (tag version, QA/Deploy titles, skip tag, checklist fields).',
    `- Workflow id: \`${ctx.workflow.id}\``
  );

  return lines.join('\n');
}

/**
 * Apply user edits to draft + release context, rebuild step payloads where needed.
 */
function applyDraftEdits(ctx, patch = {}) {
  const r = ctx.release;
  const draft = ensureDraft(ctx);

  if (patch.skip_tag === true || patch.skipTag === true) {
    r.tag_skipped = true;
    upsertDraftStep(ctx, {
      type: 'create_tag',
      title: 'Create Git tag',
      description: `Skip tagging. Proposed version ${r.next_version || 'TBD'} will still be used for ticket titles.`,
      skip: true,
      payload: null,
    });
  }

  if (patch.tag != null && String(patch.tag).trim()) {
    const tag = String(patch.tag).trim();
    r.next_version = tag;
    r.tag_skipped = false;
    const tagStep = draft.steps.find((s) => s.type === 'create_tag');
    const payload = {
      ...(tagStep?.payload || {}),
      repo: r.repository,
      tag,
      sha: r.merge_commit,
      message: patch.message || `Release ${tag}`,
      previous_version: r.previous_version,
    };
    upsertDraftStep(ctx, {
      type: 'create_tag',
      title: 'Create Git tag',
      description: [
        `Create tag \`${tag}\` on \`${r.repository}\` at \`${r.merge_commit || '?'}\`.`,
        r.previous_version ? `Previous: ${r.previous_version}` : null,
      ]
        .filter(Boolean)
        .join(' '),
      payload,
      skip: false,
    });
  }

  if (patch.qa_summary != null || patch.qaSummary != null) {
    const summary = String(patch.qa_summary ?? patch.qaSummary).trim();
    const step = draft.steps.find((s) => s.type === 'create_qa_ticket');
    if (step?.payload) {
      step.payload.summary = summary;
      step.description = `Create QA ticket in ${step.payload.projectKey} (${step.payload.issueType})${step.payload.parentKey ? ` under ${step.payload.parentKey}` : ''}: "${summary}"`;
      step.skip = false;
      step.reuse = false;
    }
  }

  if (patch.deploy_summary != null || patch.deploySummary != null) {
    const summary = String(patch.deploy_summary ?? patch.deploySummary).trim();
    const step = draft.steps.find((s) => s.type === 'create_deployment_ticket');
    if (step?.payload) {
      step.payload.summary = summary;
      step.description = `Create Deployment ticket in ${step.payload.projectKey} (${step.payload.issueType})${step.payload.parentKey ? ` under ${step.payload.parentKey}` : ''}: "${summary}"`;
      step.skip = false;
      step.reuse = false;
    }
  }

  const fieldPatches = [
    'release_summary',
    'technical_summary',
    'rollback_plan',
    'risk',
    'security',
    'customer_impact',
    'monitoring_owner',
  ];
  const { setField } = require('./fields');
  for (const key of fieldPatches) {
    if (patch[key] != null && String(patch[key]).trim()) {
      setField(ctx, key, String(patch[key]).trim(), { confidence: 'high', source: 'user_draft_edit' });
    }
  }

  return ctx;
}

module.exports = {
  ensureDraft,
  isDraftMode,
  upsertDraftStep,
  formatDraft,
  applyDraftEdits,
};
