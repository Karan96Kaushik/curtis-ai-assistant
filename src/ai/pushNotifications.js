/**
 * Outbound FCM push for the web agent.
 *
 * The Amplify chat runtime injects the real sender (service-role Supabase + FCM).
 * Discord and local CLI leave this unconfigured; the tool then reports unavailable.
 *
 * Rich fields are passed through; Amplify `sendPushToUser` / `normalizePushPayload`
 * apply the canonical contract (see lib/push/payload.ts and
 * context/android-push-notifications-spec.md).
 */

const TOOL_NAME = 'send_push_notification';

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 1000;

/**
 * @typedef {import('../../lib/push/payload').PushPayloadInput} PushPayload
 * @typedef {{ sent: number, failed: number, removed: number }} PushSendResult
 * @typedef {(userId: string, payload: PushPayload) => Promise<PushSendResult>} PushSender
 */

/** @type {PushSender | null} */
let sender = null;

/** @param {PushSender | null | undefined} fn */
function configure(fn) {
  sender = typeof fn === 'function' ? fn : null;
}

function isConfigured() {
  return Boolean(sender);
}

/**
 * Light pre-check for title/body; rich fields pass through for server normalize.
 * @param {unknown} raw
 * @returns {{ ok: true, payload: PushPayload } | { ok: false, message: string }}
 */
function normalizePayload(raw) {
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const title = String(body.title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const text = String(body.body ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return { ok: false, message: 'title is required' };
  if (!text) return { ok: false, message: 'body is required' };
  if (title.length > MAX_TITLE_CHARS) {
    return { ok: false, message: `title must be at most ${MAX_TITLE_CHARS} characters` };
  }
  if (text.length > MAX_BODY_CHARS) {
    return { ok: false, message: `body must be at most ${MAX_BODY_CHARS} characters` };
  }

  /** @type {PushPayload} */
  const payload = { ...body, title, body: text };
  return { ok: true, payload };
}

/**
 * @param {string} userId
 * @param {unknown} rawArgs
 */
async function sendToUser(userId, rawArgs) {
  if (!sender) {
    return {
      ok: false,
      message: 'Push notifications are not configured on this surface.',
      result: null,
    };
  }
  if (!userId) {
    return { ok: false, message: 'No signed-in user for this turn.', result: null };
  }
  const parsed = normalizePayload(rawArgs);
  if (!parsed.ok) return { ok: false, message: parsed.message, result: null };

  try {
    const result = await sender(userId, parsed.payload);
    return { ok: true, message: null, result, payload: parsed.payload };
  } catch (err) {
    const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
    console.error('[push] send failed:', message);
    return { ok: false, message: message || 'Push send failed', result: null };
  }
}

/**
 * @param {{ sent: number, failed: number, removed: number }} result
 * @param {{ title: string, body: string }} payload
 */
function formatResult(result, payload) {
  if (result.sent === 0 && result.failed === 0) {
    return [
      'No device tokens are registered for this user, so nothing was sent.',
      `Intended notification: "${payload.title}" — ${payload.body}`,
      'Ask them to open the Android app while signed in so it can upsert an FCM token.',
    ].join('\n');
  }
  const bits = [`Push sent to ${result.sent} device(s): "${payload.title}".`];
  if (result.failed) bits.push(`${result.failed} device(s) failed.`);
  if (result.removed) bits.push(`Removed ${result.removed} stale token(s).`);
  return bits.join(' ');
}

module.exports = {
  TOOL_NAME,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  configure,
  isConfigured,
  normalizePayload,
  sendToUser,
  formatResult,
};
