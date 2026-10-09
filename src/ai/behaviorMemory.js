const fs = require('fs');
const path = require('path');

const MAX_CHARS = Number(process.env.BEHAVIOR_MEMORY_MAX_CHARS) || 6000;

function memoryPath() {
  if (process.env.BEHAVIOR_MEMORY_PATH) return process.env.BEHAVIOR_MEMORY_PATH;
  if (process.env.CURTIS_STATE_DIR) return path.join(process.env.CURTIS_STATE_DIR, 'behavior.md');
  return path.join(__dirname, '..', '..', 'context', 'behavior.md');
}

function read() {
  try {
    const file = memoryPath();
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error('[behavior-memory] read failed:', err.message || err);
    return '';
  }
}

/** Approved preferences for the system prompt. Empty when the user has not saved any. */
function forPrompt() {
  const full = read().trim();
  if (!full) return '';
  if (full.length <= MAX_CHARS) return full;
  return `${full.slice(0, MAX_CHARS)}\n…(truncated)`;
}

module.exports = {
  read,
  forPrompt,
  memoryPath,
};
