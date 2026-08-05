/**
 * Format export artifact text (used by CLI / tools).
 */
function formatExportSummary(ctx) {
  if (!ctx?.export_paths) return 'No export artifacts yet.';
  const p = ctx.export_paths;
  return [
    'Export artifacts:',
    `- Checklist: ${p.checklist}`,
    `- Release notes: ${p.releaseNotes}`,
    `- Deployment: ${p.deployment}`,
    `- Context: ${p.context}`,
  ].join('\n');
}

module.exports = {
  formatExportSummary,
};
