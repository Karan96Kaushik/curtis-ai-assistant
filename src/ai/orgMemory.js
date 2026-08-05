const fs = require('fs');
const path = require('path');

const MEMORY_PATH =
  process.env.ORG_MEMORY_PATH ||
  path.join(__dirname, '..', '..', 'context', 'org-memory.md');

const MAX_CHARS = Number(process.env.ORG_MEMORY_MAX_CHARS) || 12000;
const ISSUE_KEY_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

function ensureDir() {
  const dir = path.dirname(MEMORY_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function read() {
  try {
    if (!fs.existsSync(MEMORY_PATH)) return '';
    return fs.readFileSync(MEMORY_PATH, 'utf8');
  } catch (err) {
    console.error('[org-memory] read failed:', err.message || err);
    return '';
  }
}

/**
 * Drop lines that only re-state issue keys already present in existing content.
 * Keeps unique lesson lines; removes duplicate key-only bullets.
 */
function dedupeKeysAgainst(existing, addition) {
  const known = new Set();
  let m;
  const re = new RegExp(ISSUE_KEY_RE.source, 'g');
  while ((m = re.exec(existing)) !== null) {
    known.add(m[1]);
  }

  const lines = String(addition).split('\n');
  const kept = [];
  for (const line of lines) {
    const keys = [...line.matchAll(new RegExp(ISSUE_KEY_RE.source, 'g'))].map((x) => x[1]);
    if (keys.length && keys.every((k) => known.has(k))) {
      // Skip pure re-listings of already-known keys (still keep lines with new keys or lesson text)
      const withoutKeys = line.replace(new RegExp(ISSUE_KEY_RE.source, 'g'), '').replace(/[[\]()*`-]/g, '').trim();
      if (withoutKeys.length < 12) continue;
    }
    for (const k of keys) known.add(k);
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function write(content) {
  ensureDir();
  const text = String(content ?? '');
  fs.writeFileSync(MEMORY_PATH, text, 'utf8');
  return text;
}

function append(chunk) {
  ensureDir();
  const existing = read();
  let addition = String(chunk ?? '').trim();
  if (!addition) return { content: existing, appended: '', skipped: true };

  addition = dedupeKeysAgainst(existing, addition);
  if (!addition) {
    return {
      content: existing,
      appended: '',
      skipped: true,
      reason: 'All issue keys already present; nothing new to append',
    };
  }

  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  const next = `${existing}${sep}${addition}\n`;
  fs.writeFileSync(MEMORY_PATH, next, 'utf8');
  return { content: next, appended: addition, skipped: false };
}

/**
 * Truncate from the start (keep newest tail) for prompt injection.
 */
function forPrompt() {
  const full = read().trim();
  if (!full) return '(empty — use memory_append / memory_write to store org facts)';
  if (full.length <= MAX_CHARS) return full;
  return `…(truncated older content)\n${full.slice(-MAX_CHARS)}`;
}

function getPath() {
  return MEMORY_PATH;
}

/**
 * Re-read and format a verified write result for tools.
 */
function formatWriteResult({ action, appended }) {
  const content = read();
  const pathLabel = getPath();
  const bytes = Buffer.byteLength(content, 'utf8');
  const tail = content.trim().slice(-600);
  const lines = [
    action === 'append' ? 'Appended to org memory (verified).' : 'Wrote org memory (verified).',
    `Path: ${pathLabel}`,
    `Bytes: ${bytes}`,
  ];
  if (appended) {
    lines.push(`Appended chunk:\n${String(appended).slice(0, 400)}`);
  }
  lines.push(`Tail preview:\n${tail}`);
  return lines.join('\n');
}

module.exports = {
  MEMORY_PATH,
  read,
  write,
  append,
  forPrompt,
  getPath,
  formatWriteResult,
  dedupeKeysAgainst,
};
