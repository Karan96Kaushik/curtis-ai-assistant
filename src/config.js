/**
 * Application config — change values here at the code level.
 * Optional env vars override these defaults when set.
 */

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  /**
   * Hard gate for AI create/update/delete:
   * - true  → mutating tools only stage a plan; Jira writes run after the user
   *           confirms in a later message (confirm_pending). Same-turn confirm is blocked.
   * - false → mutating tools execute immediately (no confirmation step).
   *
   * Toggle here, or set REQUIRE_CONFIRMATION=0|1 in .env to override.
   */
  REQUIRE_CONFIRMATION: envBool('REQUIRE_CONFIRMATION', true),

  /** Localhost WS port for the Firefox extension bridge. */
  EXTENSION_WS_PORT: envInt('EXTENSION_WS_PORT', 8765),

  /**
   * Optional shared secret. If set, the extension must send the same token in hello.
   * Empty string = no token required.
   */
  EXTENSION_WS_TOKEN: String(process.env.EXTENSION_WS_TOKEN || '').trim(),

  /** Directory for persisted ReleaseContext JSON and export artifacts. */
  WF_RELEASE_DIR: String(process.env.WF_RELEASE_DIR || 'context/releases').trim() || 'context/releases',
};
