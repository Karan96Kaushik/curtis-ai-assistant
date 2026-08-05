/**
 * Semver helpers for release version proposals.
 */

const STABLE_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)$/i;

function parseStableTag(name) {
  const m = String(name || '').trim().match(STABLE_TAG_RE);
  if (!m) return null;
  return {
    raw: String(name).trim(),
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    hasV: /^v/i.test(String(name).trim()),
  };
}

function compareParsed(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatVersion(parsed, bump) {
  let { major, minor, patch, hasV } = parsed;
  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  const body = `${major}.${minor}.${patch}`;
  return hasV ? `v${body}` : body;
}

/**
 * Pick latest stable tag from a list of tag names / objects with .name.
 * @param {Array<string|{name:string}>} tags
 */
function latestStable(tags = []) {
  const parsed = tags
    .map((t) => parseStableTag(typeof t === 'string' ? t : t?.name))
    .filter(Boolean)
    .sort(compareParsed);
  return parsed.length ? parsed[parsed.length - 1] : null;
}

/**
 * Infer bump from PR/commits text. Defaults to patch.
 * @param {{ title?: string, body?: string, commits?: Array<{message?:string}> }} evidence
 */
function inferBump(evidence = {}) {
  const text = [
    evidence.title || '',
    evidence.body || '',
    ...(evidence.commits || []).map((c) => c.message || c.commit?.message || ''),
  ]
    .join('\n')
    .toLowerCase();

  if (/\b(breaking(\s+change)?|major)\b/.test(text) || /!:/.test(text)) {
    return { bump: 'major', reason: 'Breaking change indicators in PR/commits' };
  }
  if (
    /\b(feat|feature|enhancement|minor)\b/.test(text) ||
    /^feat(\(.+\))?:/m.test(text)
  ) {
    return { bump: 'minor', reason: 'Feature / enhancement indicators in PR/commits' };
  }
  return { bump: 'patch', reason: 'Bug fix / patch (default)' };
}

/**
 * @param {Array<string|{name:string}>} tags
 * @param {{ title?: string, body?: string, commits?: object[] }} evidence
 */
function proposeNextVersion(tags, evidence = {}) {
  const latest = latestStable(tags);
  const { bump, reason } = inferBump(evidence);
  if (!latest) {
    const next = bump === 'major' ? 'v1.0.0' : bump === 'minor' ? 'v0.1.0' : 'v0.0.1';
    return {
      previous_version: null,
      next_version: next,
      bump,
      reason: `${reason}; no prior stable tag found`,
    };
  }
  return {
    previous_version: latest.raw,
    next_version: formatVersion(latest, bump),
    bump,
    reason,
  };
}

module.exports = {
  parseStableTag,
  latestStable,
  inferBump,
  proposeNextVersion,
  formatVersion,
};
