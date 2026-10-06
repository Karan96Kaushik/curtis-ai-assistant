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
    // Preserve executed status on re-plan so a retry never repeats a finished write.
    done: Boolean(step.done ?? draft.steps[idx]?.done),
  };
  if (idx >= 0) draft.steps[idx] = entry;
  else draft.steps.push(entry);
  return entry;
}

/** Mark a planned step as executed (write completed). */
function markStepDone(ctx, type) {
  const draft = ensureDraft(ctx);
  const step = draft.steps.find((s) => s.type === type);
  if (step) step.done = true;
  return step;
}

function formatDraft(ctx) {
  const { jiraLink } = require('./helpers');
  const r = ctx.release || {};
  const draft = ensureDraft(ctx);
  const fieldValue = (key) => ctx.fields?.[key]?.value ?? r[key] ?? 'Unknown';

  // Every field from the release-form spec (context/release-form-context.txt, lines 10-32),
  // listed in the same order/naming so the draft review shows the complete form up front.
  const lines = [
    `# Release draft — ${ctx.workflow.id}`,
    '',
    '## Release form',
    `- **Release #**: ${r.next_version || '—'}`,
    `- **Developer**: ${r.developer || '—'}`,
    `- **Component**: ${r.component || '—'}`,
    `- **Release Summary**: ${fieldValue('release_summary')}`,
    `- **Product Release - Feature Group**: ${fieldValue('feature_group')}`,
    `- **Release Submission Date**: ${r.submission_date || '—'}`,
    `- **Previous release #**: ${r.previous_version || '—'}`,
    `- **New release #**: ${r.next_version || '—'}`,
    `- **Github link**: ${r.github_link || '—'}`,
    `- **Jira Task Ref**: ${jiraLink(r.development_ticket) || '—'}${r.development_issue_type ? ` (${r.development_issue_type})` : ''}`,
    `- **QAlity test ref**: ${jiraLink(r.qa_ticket) || (draft.steps.some((s) => s.type === 'create_qa_ticket' && s.payload && !s.skip) ? '— (will be created)' : '—')}`,
    `- **Jira Task for deployment to prod**: ${jiraLink(r.deployment_ticket) || (draft.steps.some((s) => s.type === 'create_deployment_ticket' && s.payload && !s.skip) ? '— (will be created)' : '—')}`,
    `- **Changes to software stack**: ${fieldValue('software_stack_changes')}`,
    `- **Snyk security issues**: ${fieldValue('snyk_security')}`,
    `- **Release risks**: ${fieldValue('risk')}`,
    `- **Release rollback / backout plan**: ${fieldValue('rollback_plan')}`,
    `- **Potential to contact the customer directly**: ${fieldValue('customer_impact')}`,
    `- **Release security**: ${fieldValue('security')}`,
    `- **Post-release monitoring**: ${fieldValue('monitoring_owner')}`,
    '',
    '### Technical summary (internal — not a release-form field)',
    fieldValue('technical_summary'),
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
      lines.push('');
      lines.push(`### ${i + 1}. ${step.title}`);
      lines.push(step.description || '(no description)');
      const p = step.payload;
      if (p && !step.skip) {
        if (step.type === 'create_tag') {
          if (p.tag) lines.push(`- Tag: \`${p.tag}\``);
          if (p.sha) lines.push(`- Commit: \`${p.sha}\``);
          if (p.message) lines.push(`- Annotation: ${p.message}`);
        } else if (p.summary) {
          lines.push(`- Summary: ${p.summary}`);
          if (p.projectKey) lines.push(`- Project: ${p.projectKey} (${p.issueType || '?'})`);
          if (p.parentKey) lines.push(`- Parent: ${p.parentKey}`);
          if (p.description) {
            lines.push('- Ticket body:');
            for (const bodyLine of String(p.description).split('\n')) {
              lines.push(`  ${bodyLine}`);
            }
          }
        }
      }
      if (step.done) lines.push('_Action: already executed ✓_');
      else if (step.skip) lines.push('_Action: skip (no write)_');
      else lines.push('_Action: will create/write on approval_');
    });
  }

  lines.push(
    '',
    '## Review',
    '_Reviewer approvals are never auto-generated — they must come from an actual reviewer._'
  );

  if (ctx.warnings?.length) {
    lines.push('', '## Warnings');
    for (const w of ctx.warnings) lines.push(`- ${w}`);
  }

  lines.push(
    '',
    '## How to proceed',
    '- Approve this draft to execute ALL the writes above (one confirmation covers the whole plan).',
    '- Or ask for changes (tag version, QA/Deploy titles, skip tag, checklist fields).',
    `- Workflow id: \`${ctx.workflow.id}\``
  );

  return lines.join('\n');
}

/**
 * Build the ordered list of remaining writes from an approved draft
 * (skipped and already-executed steps are excluded).
 */
function buildExecutionQueue(ctx) {
  const draft = ensureDraft(ctx);
  return (draft.steps || [])
    .filter((s) => !s.skip && !s.done && s.payload)
    .map((s) => ({ type: s.type, title: s.title, payload: s.payload }));
}

/**
 * Apply user edits to draft + release context, rebuild step payloads where needed.
 * Accepts both draft tool fields and revise_pending aliases (summary, skipTag, …).
 */
function applyDraftEdits(ctx, patch = {}) {
  const r = ctx.release;
  const draft = ensureDraft(ctx);

  // Bare `summary` from revise_pending → QA title unless deploy was named
  let qaSummary = patch.qa_summary ?? patch.qaSummary;
  let deploySummary = patch.deploy_summary ?? patch.deploySummary;
  if (patch.summary != null && String(patch.summary).trim()) {
    const bare = String(patch.summary).trim();
    if (qaSummary == null && deploySummary == null) {
      qaSummary = bare;
    }
  }

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
    const prevMsg = tagStep?.payload?.message;
    const keepPrevMsg = prevMsg && !/^Release\s+/i.test(prevMsg);
    const payload = {
      ...(tagStep?.payload || {}),
      repo: r.repository,
      tag,
      sha: r.merge_commit,
      message: patch.message || (keepPrevMsg ? prevMsg : `Release ${tag}`),
      previous_version: r.previous_version,
    };
    upsertDraftStep(ctx, {
      type: 'create_tag',
      title: 'Create Git tag',
      description: [
        `Create annotated tag \`${tag}\` on \`${r.repository}\` at commit \`${r.merge_commit || '?'}\`.`,
        r.previous_version ? `Previous tag: ${r.previous_version}.` : 'No previous stable tag found.',
      ]
        .filter(Boolean)
        .join(' '),
      payload,
      skip: false,
    });
  }

  if (patch.message != null && String(patch.message).trim() && patch.tag == null) {
    const tagStep = draft.steps.find((s) => s.type === 'create_tag' && s.payload);
    if (tagStep?.payload) {
      tagStep.payload.message = String(patch.message).trim();
      tagStep.description = [
        `Create annotated tag \`${tagStep.payload.tag}\` on \`${r.repository}\` at commit \`${r.merge_commit || '?'}\`.`,
        `Annotation: ${tagStep.payload.message}.`,
      ].join(' ');
    }
  }

  if (qaSummary != null && String(qaSummary).trim()) {
    const summary = String(qaSummary).trim();
    const step = draft.steps.find((s) => s.type === 'create_qa_ticket');
    if (step?.payload) {
      step.payload.summary = summary;
      step.description = [
        `Create Jira ${step.payload.issueType} in ${step.payload.projectKey}`,
        step.payload.parentKey ? `under parent ${step.payload.parentKey}` : null,
        `with summary "${summary}".`,
        'Description will include PR, repo, development ticket, and version.',
      ]
        .filter(Boolean)
        .join(' ');
      step.skip = false;
    }
  }

  if (deploySummary != null && String(deploySummary).trim()) {
    const summary = String(deploySummary).trim();
    const step = draft.steps.find((s) => s.type === 'create_deployment_ticket');
    if (step?.payload) {
      step.payload.summary = summary;
      step.description = [
        `Create Jira ${step.payload.issueType} in ${step.payload.projectKey}`,
        step.payload.parentKey ? `under parent ${step.payload.parentKey}` : null,
        `with summary "${summary}".`,
        'Description will include PR, repo, development/QA tickets, and version.',
      ]
        .filter(Boolean)
        .join(' ');
      step.skip = false;
    }
  }

  const fieldPatches = [
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
  markStepDone,
  formatDraft,
  applyDraftEdits,
  buildExecutionQueue,
};
