/**
 * Jira issue-key helpers shared by intent routing and tools.
 */

const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/gi;
const STRICT_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/i;

function extractIssueKeys(text) {
  const out = [];
  const seen = new Set();
  const s = String(text || '');
  let m;
  const re = new RegExp(ISSUE_KEY_RE.source, 'gi');
  while ((m = re.exec(s)) !== null) {
    const key = m[1].toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function normalizeIssueKey(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return STRICT_KEY_RE.test(s) ? s : null;
}

/** True when the whole query is only an issue key (maybe with punctuation). */
function isBareIssueKeyQuery(text) {
  const t = String(text || '').trim().replace(/[.,!?;:'"]+$/g, '');
  return Boolean(normalizeIssueKey(t));
}

/**
 * Short affirmatives / "details" that mean "fetch that ticket" after a prior key mention.
 */
function looksLikeIssueDetailFollowUp(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 120) return false;
  if (extractIssueKeys(t).length) return false; // key present → handled separately
  return (
    /^(yes|yeah|yep|yup|ok|okay|sure|do it|go ahead|please|pls)([.!?]|$)/i.test(t) ||
    /\b(pull|fetch|get|show|list|give)\b.{0,40}\b(details?|full|record|info|description|ticket|issue)\b/i.test(t) ||
    /^(details?|more details?|full details?|tell me more|more info|the details)([.!?]?)$/i.test(t) ||
    /\b(what('s| is) (that|this|it)|about (that|this|it))\b/i.test(t)
  );
}

/**
 * Find the most recently mentioned issue key in conversation history (newest last).
 * @param {{ role?: string, content?: string }[]} history
 */
function lastIssueKeyFromHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i--) {
    const keys = extractIssueKeys(history[i]?.content || '');
    if (keys.length) return keys[keys.length - 1];
  }
  return null;
}

module.exports = {
  ISSUE_KEY_RE,
  extractIssueKeys,
  normalizeIssueKey,
  isBareIssueKeyQuery,
  looksLikeIssueDetailFollowUp,
  lastIssueKeyFromHistory,
};
