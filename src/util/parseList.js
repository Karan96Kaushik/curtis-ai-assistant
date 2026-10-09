/**
 * Tool args often arrive as "a, b" strings or arrays; normalize to trimmed strings.
 * @param {unknown} raw
 * @returns {string[]}
 */
function parseList(raw) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(',');
  return items.map((s) => String(s).trim()).filter(Boolean);
}

module.exports = { parseList };
