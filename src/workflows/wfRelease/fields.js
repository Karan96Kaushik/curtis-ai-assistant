/**
 * Checklist field helpers — each field tracks value / confidence / source.
 */

const FIELD_KEYS = [
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
  'release_summary',
  'technical_summary',
  'rollback_plan',
  'risk',
  'security',
  'customer_impact',
  'monitoring_owner',
];

const SKIPPED = 'Skipped by user';
const UNKNOWN = 'Unknown';

function setField(ctx, key, value, { confidence = 'medium', source = 'inferred' } = {}) {
  if (!ctx.fields) ctx.fields = {};
  ctx.fields[key] = {
    value,
    confidence,
    source,
    updated_at: new Date().toISOString(),
  };
  if (ctx.release && Object.prototype.hasOwnProperty.call(ctx.release, key)) {
    ctx.release[key] = value;
  }
  ctx.unknown_fields = (ctx.unknown_fields || []).filter((f) => f !== key);
  return ctx;
}

function markUnknown(ctx, key, reason = UNKNOWN) {
  if (!ctx.fields) ctx.fields = {};
  ctx.fields[key] = {
    value: reason,
    confidence: 'low',
    source: 'unknown',
    updated_at: new Date().toISOString(),
  };
  if (!ctx.unknown_fields.includes(key)) ctx.unknown_fields.push(key);
  return ctx;
}

function markSkipped(ctx, key) {
  return setField(ctx, key, SKIPPED, { confidence: 'high', source: 'user_skip' });
}

function isUnresolved(entry) {
  if (!entry) return true;
  const v = entry.value;
  if (v == null || v === '' || v === UNKNOWN) return true;
  if (entry.source === 'unknown') return true;
  return false;
}

function listUnresolved(ctx) {
  return FIELD_KEYS.filter((key) => {
    const entry = ctx.fields?.[key];
    if (!entry) {
      // Prefer release values already filled
      const rv = ctx.release?.[key];
      if (rv != null && rv !== '' && rv !== false) return false;
      return [
        'rollback_plan',
        'risk',
        'security',
        'customer_impact',
        'monitoring_owner',
        'release_summary',
        'technical_summary',
      ].includes(key);
    }
    return isUnresolved(entry) && entry.value !== SKIPPED;
  });
}

function formatFieldReview(ctx) {
  const lines = [];
  for (const key of FIELD_KEYS) {
    const entry = ctx.fields?.[key];
    const value = entry?.value ?? ctx.release?.[key] ?? UNKNOWN;
    const confidence = entry?.confidence ?? (ctx.release?.[key] != null ? 'high' : 'low');
    const source = entry?.source ?? (ctx.release?.[key] != null ? 'context' : 'unknown');
    lines.push(`${key}: ${value}`);
    lines.push(`  confidence=${confidence} source=${source}`);
  }
  return lines.join('\n');
}

module.exports = {
  FIELD_KEYS,
  SKIPPED,
  UNKNOWN,
  setField,
  markUnknown,
  markSkipped,
  isUnresolved,
  listUnresolved,
  formatFieldReview,
};
