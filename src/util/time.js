/**
 * All user-facing times and schedule timers use UK local time (Europe/London).
 * In summer this is BST (UTC+1); in winter GMT (UTC+0).
 */
const TZ = 'Europe/London';

/**
 * @param {Date|string|number} [input]
 * @returns {Date}
 */
function asDate(input = Date.now()) {
  if (input instanceof Date) return input;
  return new Date(input);
}

/**
 * Format a Date for display in UK local time, e.g. "Mon 20 Jul 2026, 13:30 BST".
 * @param {Date|string|number} [input]
 */
function formatUK(input = Date.now()) {
  const d = asDate(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(d);
}

/**
 * Current UK local wall-clock parts (for prompts / relative parsing).
 * @param {Date|string|number} [input]
 */
function ukParts(input = Date.now()) {
  const d = asDate(input);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    zone: get('timeZoneName') || 'BST',
    isoLocal: `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`,
  };
}

/**
 * Absolute offset of Europe/London vs UTC in minutes (e.g. 60 in BST).
 * @param {Date|string|number} [input]
 */
function ukOffsetMinutes(input = Date.now()) {
  const d = asDate(input);
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const london = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  return Math.round((london.getTime() - utc.getTime()) / 60000);
}

/**
 * Offset string for ISO, e.g. "+01:00" during BST.
 * @param {Date|string|number} [input]
 */
function ukOffsetIso(input = Date.now()) {
  const mins = ukOffsetMinutes(input);
  const sign = mins >= 0 ? '+' : '-';
  const abs = Math.abs(mins);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/**
 * Normalize a run_at string into a UTC ISO instant for storage.
 * - Explicit Z / ±offset → parse as-is
 * - Naive local datetime → treat as Europe/London (BST in summer, GMT in winter)
 *
 * @param {string} raw
 * @returns {string} UTC ISO string
 */
function normalizeRunAt(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('Empty run_at');

  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid run_at: ${s}`);
    return d.toISOString();
  }

  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (m) {
    const [, y, mo, d, h, mi, se = '00'] = m;
    // Use noon that calendar day to pick BST vs GMT offset (stable within the day)
    const noonUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), 12, 0, 0);
    const offset = ukOffsetIso(noonUtc);
    const withOffset = `${y}-${mo}-${d}T${h}:${mi}:${String(se).padStart(2, '0')}${offset}`;
    const parsed = new Date(withOffset);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid run_at: ${s}`);
    return parsed.toISOString();
  }

  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid run_at: ${s}`);
  return d.toISOString();
}

/**
 * Options for cron-parser so cron fields are interpreted in Europe/London.
 * @param {Date} [currentDate]
 */
function cronOptions(currentDate = new Date()) {
  return { tz: TZ, currentDate };
}

/**
 * Prompt snippet: current UK time for the LLM.
 */
function nowForPrompt() {
  const p = ukParts();
  return `${formatUK()} (Europe/London — use this timezone for all schedules; never assume UTC)`;
}

module.exports = {
  TZ,
  formatUK,
  ukParts,
  ukOffsetMinutes,
  ukOffsetIso,
  normalizeRunAt,
  cronOptions,
  nowForPrompt,
};
