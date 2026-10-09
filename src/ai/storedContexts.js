const fs = require('fs');
const path = require('path');
const orgMemory = require('./orgMemory');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_READ = 12000;

function titleFromSlug(slug) {
  if (slug === 'org-memory') return 'Org memory';
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function indexFile() {
  const state = process.env.CURTIS_STATE_DIR;
  if (!state) return null;
  return path.join(state, 'contexts', 'index.json');
}

function readIndex() {
  const file = indexFile();
  if (!file) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row) => row && SLUG_RE.test(String(row.slug || '')));
  } catch {
    return [];
  }
}

/** Repo context files are available to the local bot. The web runtime uses the materialized index. */
function repoContextDir() {
  if (process.env.CURTIS_SURFACE === 'web') return null;
  return path.join(__dirname, '..', '..', 'context');
}

function listRepoEntries(seen) {
  const dir = repoContextDir();
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/\.(md|txt)$/.test(name)) continue;
    if (name === 'org-memory.md' || name === 'behavior.md') continue;
    const slug = name.replace(/\.(md|txt)$/, '');
    if (!SLUG_RE.test(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, title: titleFromSlug(slug), kind: 'reference' });
  }
  return out;
}

function listEntries() {
  const fromIndex = readIndex().map((row) => ({
    slug: String(row.slug),
    title: String(row.title || titleFromSlug(row.slug)),
    kind: 'reference',
  }));
  const seen = new Set(fromIndex.map((row) => row.slug));
  return [...fromIndex, ...listRepoEntries(seen)];
}

function forPrompt() {
  const rows = listEntries();
  if (!rows.length) return '';
  const lines = rows.map((row) => `- ${row.slug}: ${row.title}`);
  return ['Stored contexts (call context_read with the slug when a task needs that document):', ...lines].join('\n');
}

function readRepo(slug) {
  const dir = repoContextDir();
  if (!dir) return '';
  for (const ext of ['.md', '.txt']) {
    const full = path.resolve(dir, `${slug}${ext}`);
    if (!full.startsWith(`${path.resolve(dir)}${path.sep}`)) continue;
    if (!fs.existsSync(full)) continue;
    return fs.readFileSync(full, 'utf8');
  }
  return '';
}

function readStateFile(slug) {
  const state = process.env.CURTIS_STATE_DIR;
  if (!state) return '';
  const full = path.resolve(state, 'contexts', `${slug}.md`);
  const root = path.resolve(state, 'contexts');
  if (!full.startsWith(`${root}${path.sep}`)) return '';
  if (!fs.existsSync(full)) return '';
  return fs.readFileSync(full, 'utf8');
}

function readBySlug(slug) {
  const key = String(slug || '').trim();
  if (key === 'org-memory') return orgMemory.read();
  if (!SLUG_RE.test(key)) {
    throw new Error('Invalid context slug. Use lowercase letters, numbers, and hyphens.');
  }
  const fromState = readStateFile(key);
  if (fromState) return fromState;
  return readRepo(key);
}

function clip(text) {
  const body = String(text || '');
  if (body.length <= MAX_READ) return body;
  return `${body.slice(0, MAX_READ)}\n…(truncated)`;
}

module.exports = {
  listEntries,
  forPrompt,
  readBySlug,
  clip,
};
