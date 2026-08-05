const fs = require('fs');
const path = require('path');
const config = require('../../config');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

function releasesDir() {
  const configured = config.WF_RELEASE_DIR || 'context/releases';
  return path.isAbsolute(configured)
    ? configured
    : path.join(PROJECT_ROOT, configured);
}

function ensureDir() {
  const dir = releasesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function filePath(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('Invalid workflow id');
  return path.join(ensureDir(), `${safe}.json`);
}

function read(id) {
  const fp = filePath(id);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch (err) {
    console.error(`Failed to read release context ${id}:`, err.message);
    return null;
  }
}

function write(ctx) {
  if (!ctx?.workflow?.id) throw new Error('ReleaseContext missing workflow.id');
  ensureDir();
  ctx.workflow.updated_at = new Date().toISOString();
  fs.writeFileSync(filePath(ctx.workflow.id), JSON.stringify(ctx, null, 2), 'utf8');
  return ctx;
}

function listIds() {
  const dir = ensureDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

function remove(id) {
  const fp = filePath(id);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
}

module.exports = {
  get RELEASES_DIR() {
    return releasesDir();
  },
  read,
  write,
  listIds,
  remove,
  filePath,
};
