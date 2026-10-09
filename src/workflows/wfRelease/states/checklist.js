const fs = require('fs');
const path = require('path');
const { chat } = require('../../../integrations/aiRouter');
const { setField, markUnknown, listUnresolved } = require('../fields');
const { audit, setState, STATES } = require('../context');
const { warn, jiraLink } = require('../helpers');
const store = require('../store');
const { formatDraft, formatReleaseForm } = require('../draft');

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
const SPEC_MAX_CHARS = 14000;
let releaseFormContextCache = null;

/** The spec part of the file (engineering notes dropped, table padding collapsed). */
function loadReleaseFormContext() {
  if (releaseFormContextCache != null) return releaseFormContextCache;
  try {
    const raw = fs.readFileSync(RELEASE_FORM_CONTEXT_PATH, 'utf8');
    releaseFormContextCache = raw
      .split(/^## Engineering notes/m)[0]
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/^\|( ?-+ ?\|)+$/gm, '|---|---|')
      .slice(0, SPEC_MAX_CHARS);
  } catch {
    releaseFormContextCache = '';
  }
  return releaseFormContextCache;
}

const LLM_FIELDS = [
  'release_summary',
  'technical_summary',
  'feature_group',
  'software_stack_changes',
  'rollback_plan',
  'risk',
  'security',
  'customer_impact',
  'monitoring_owner',
  'snyk_security',
];

const FAILING_STATES = new Set(['failure', 'error', 'timed_out', 'cancelled', 'action_required']);

/**
 * Snyk field from the PR's Snyk status/check-runs. A passing PR check only covers issues
 * the PR introduced, so the value always asks for a Critical/High confirmation.
 */
function snykFromChecks(checks = []) {
  if (!checks.length) return null;
  const describe = (c) =>
    `${c.name}${c.description ? ` — ${c.description}` : ''}${c.url ? ` (${c.url})` : ''}`;
  const failing = checks.filter((c) => FAILING_STATES.has(c.state));
  const pending = checks.filter((c) => ['pending', 'queued', 'in_progress'].includes(c.state));
  if (failing.length) {
    return `Snyk PR check failing: ${failing.map(describe).join('; ')}. Review the open issues and confirm whether any are Critical/High (and whether any were ignored) before release.`;
  }
  if (pending.length) {
    return `Snyk PR check still running: ${pending.map(describe).join('; ')}. Re-check before release.`;
  }
  return `Snyk PR check passed: ${checks.map(describe).join('; ')}. Confirm in Snyk that no Critical/High issues are open on the project.`;
}

function heuristicDefaults(ctx) {
  const r = ctx.release;
  return {
    release_summary: `Release ${r.next_version || ''} of ${r.component || r.repository || 'the component'}: ${r.pr_title || ctx._jira_dev_summary || 'see linked PR/Jira'}`.trim(),
    technical_summary: r.commits?.length
      ? r.commits
          .slice(0, 8)
          .map((c) => `- ${c.message?.split('\n')[0]}`)
          .join('\n')
      : null,
    feature_group: 'N/A',
    software_stack_changes: 'N/A',
    rollback_plan: r.previous_version
      ? `code update/rollback to ${r.previous_version}`
      : 'code update/rollback to the previous production release',
    risk: `Changes in ${r.component || 'this component'} may not behave as expected in production, affecting the functionality described in the release summary. Impact is limited to ${r.component || 'this component'}.`,
    security: 'N/A — no evidence of changes to authentication, credentials, access control or sensitive data handling.',
    customer_impact: 'N/A',
    monitoring_owner: `${r.developer || 'Developer'} - ${r.component || 'the component'} - azure logs - post release`,
  };
}

/**
 * Fill every release-form field in one LLM pass. Fields the user edited on the draft are
 * kept as-is. Thin evidence → best guess, flagged on the form (never Unknown).
 * @param {object} ctx
 * @param {{ notes?: string }} [opts] extra context from the user (draft "regenerate with …")
 */
async function populateFields(ctx, { notes } = {}) {
  const r = ctx.release;

  // Release Submission Date is deterministic — set once, not LLM-generated.
  if (!r.submission_date) {
    r.submission_date = new Date().toISOString().slice(0, 10);
  }
  const userEdited = (key) => ctx.fields?.[key]?.source === 'user_draft_edit';
  if (!userEdited('submission_date')) {
    setField(ctx, 'submission_date', r.submission_date, { confidence: 'high', source: 'system' });
  }
  if (r.github_link && !userEdited('github_link')) {
    setField(ctx, 'github_link', r.github_link, { confidence: 'high', source: 'github' });
  }
  if (notes) {
    ctx.user_notes = [...(ctx.user_notes || []), String(notes).trim()];
  }

  const fixed = Object.fromEntries(
    LLM_FIELDS.filter(userEdited).map((key) => [key, ctx.fields[key].value])
  );
  const evidence = {
    repository: r.repository,
    component: r.component,
    github_link: r.github_link,
    pr: r.source_pr,
    pr_title: r.pr_title,
    pr_body: (r.pr_body || '').slice(0, 2000),
    pr_merged: r.pr_merged,
    ci_status: r.ci_status,
    snyk_checks: r.snyk_checks,
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
    user_notes: ctx.user_notes || [],
    fields_set_by_user: fixed,
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
            'You are drafting a complete release form. Given ALL of the context evidence below at once',
            '(PR, Jira, commits, files, CI, Snyk checks, version, user notes), write every release-form field in a single pass,',
            'following the field definitions and generation rules in the release form specification below.',
            '',
            formSpec ? `RELEASE FORM SPECIFICATION:\n${formSpec}` : '',
            '',
            `Reply with JSON only: {${LLM_FIELDS.map((k) => `"${k}"`).join(',')},"guessed":[]}.`,
            'Every field must have a value. When the evidence is thin or unclear, give your best guess from what is available',
            'and list that field\'s key in "guessed" so a human can verify it. Use "N/A" only when a field genuinely does not apply.',
            'Never use "N/A" for release_summary, rollback_plan, or monitoring_owner. Match the worked examples:',
            'rollback is "code update/rollback" (name the previous version) or "turn off using MAF params";',
            'monitoring is who + what + when, as one line or a numbered per-function list.',
            'snyk_security: when the evidence names a High or Critical package, write it like the worked examples (severity, manifest, package, subdep / not directly referenced / no update). Use null when the evidence has no package-level finding — do not invent package names.',
            'user_notes are authoritative extra context from the developer. Keep fields_set_by_user exactly as given.',
            'Never invent ticket keys, versions, URLs, security-scan results, or approvals — those come only from the evidence.',
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
    warn(ctx, `LLM release form generation failed: ${err.message}`);
  }

  const guessed = new Set(Array.isArray(generated?.guessed) ? generated.guessed : []);
  const fallback = heuristicDefaults(ctx);
  for (const key of LLM_FIELDS) {
    if (userEdited(key)) continue;
    const llmValue = generated?.[key];
    const value = present(llmValue) ? String(llmValue).trim() : fallback[key];
    if (!present(value)) {
      markUnknown(ctx, key);
      continue;
    }
    setField(ctx, key, value, {
      confidence: present(llmValue) ? 'medium' : 'low',
      source: present(llmValue) ? 'llm' : 'heuristic',
      guess: present(llmValue) ? guessed.has(key) : true,
    });
  }

  if (!userEdited('snyk_security') && !packageLevelSnyk(generated?.snyk_security)) {
    const snyk = snykFromChecks(r.snyk_checks);
    setField(
      ctx,
      'snyk_security',
      snyk || 'Not verified — no Snyk check found on the PR; check Snyk for open Critical/High issues before release.',
      { confidence: snyk ? 'medium' : 'low', source: snyk ? 'github_snyk_check' : 'none' }
    );
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
    if (r[key] != null && r[key] !== '' && !ctx.fields?.[key]) {
      setField(ctx, key, r[key], { confidence: 'high', source: 'context' });
    }
  }

  ctx.unknown_fields = listUnresolved(ctx);
  audit(ctx, 'populate_fields', { notes: notes || null, guessed: [...guessed] });
}

function present(v) {
  return v != null && String(v).trim() !== '';
}

/** A Snyk value that names a finding. N/A leaves the PR-check fallback in place. */
function packageLevelSnyk(v) {
  if (!present(v)) return false;
  return !/^(n\/a|null|none|unknown)$/i.test(String(v).trim());
}

async function generateReleaseContext(ctx) {
  await populateFields(ctx);
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
  if (!r.qa_ticket) warnings.push('QA ticket not created');
  if (!r.deployment_ticket) warnings.push('Deployment ticket not created');
  if (!r.development_ticket) warnings.push('Development ticket missing');

  for (const w of warnings) warn(ctx, w);

  const hardMissing = !r.tag_skipped && (!r.github_tag_created || !r.next_version);
  audit(ctx, 'validated', { warnings: ctx.warnings, hardMissing });

  if (hardMissing) {
    return {
      pause: 'user_input',
      message: `Validation blocked: git tag required before export (or skip the tag on the draft).\nWarnings:\n${(ctx.warnings || []).map((w) => `- ${w}`).join('\n')}`,
    };
  }

  setState(ctx, STATES.EXPORT);
  return { continue: true };
}

async function exportArtifacts(ctx) {
  const r = ctx.release;
  const dir = store.RELEASES_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const form = formatReleaseForm(ctx, { final: true });
  const checklist = [
    `# Release form — ${r.component || r.repository || ''} ${r.next_version || ''}`.trim(),
    '',
    form,
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
    `Tag: ${r.next_version}${r.tag_url ? ` (${r.tag_url})` : ''}`,
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
    `Monitoring: ${r.monitoring_owner || 'n/a'}`,
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
      `# Release form — ${r.component || r.repository || ''} ${r.next_version || ''}`.trim(),
      `_Workflow ${ctx.workflow.id} complete. Fields marked "best guess" need a quick check before submitting._`,
      '',
      form,
      ...(ctx.warnings?.length ? ['', '**Warnings**', ...ctx.warnings.map((w) => `- ${w}`)] : []),
      '',
      `Saved: ${paths.checklist}`,
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
  populateFields,
  snykFromChecks,
  loadReleaseFormContext,
  draftReview,
  validate,
  exportArtifacts,
  recover,
};
