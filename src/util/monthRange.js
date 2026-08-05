/**
 * Resolve a calendar month from structured args or natural language into an
 * inclusive/exclusive date range usable by Jira JQL and GitHub search.
 *
 * "Now" is Europe/London wall-clock so month boundaries match the user's day.
 */

const { ukParts } = require('./time');

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const NAME_TO_NUMBER = new Map();
MONTH_NAMES.forEach((name, i) => {
  NAME_TO_NUMBER.set(name.toLowerCase(), i + 1);
  NAME_TO_NUMBER.set(name.slice(0, 3).toLowerCase(), i + 1);
});
NAME_TO_NUMBER.set('sept', 9);

const MONTH_NAME_PATTERN =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function lastDayOf(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function currentMonth(now) {
  if (now) {
    const d = now instanceof Date ? now : new Date(now);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  }
  const p = ukParts();
  return { year: p.year, month: p.month };
}

function shiftMonth({ year, month }, delta) {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

/**
 * Build the full range descriptor for a year/month pair.
 * @param {number} year
 * @param {number} month 1-12
 */
function monthRange(year, month) {
  if (!Number.isInteger(year) || year < 1970 || year > 2100) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}`);
  }

  const start = `${year}-${pad2(month)}-01`;
  const end = `${year}-${pad2(month)}-${pad2(lastDayOf(year, month))}`;
  const next = shiftMonth({ year, month }, 1);
  const endExclusive = `${next.year}-${pad2(next.month)}-01`;

  return {
    year,
    month,
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    slug: `${year}-${pad2(month)}`,
    start,
    end,
    endExclusive,
    dateRange: `${start}..${end}`,
  };
}

/**
 * Parse a single month token: "2026-07", "July", "jul", "2026", "7".
 * @param {string} token
 * @returns {{ year?: number, month?: number }|null}
 */
function parseMonthToken(token) {
  const s = String(token || '').trim();
  if (!s) return null;

  const ym = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (ym) return { year: Number(ym[1]), month: Number(ym[2]) };

  const my = s.match(/^(\d{1,2})[-/](\d{4})$/);
  if (my) return { year: Number(my[2]), month: Number(my[1]) };

  const name = NAME_TO_NUMBER.get(s.toLowerCase());
  if (name) return { month: name };

  if (/^\d{4}$/.test(s)) return { year: Number(s) };
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    if (n >= 1 && n <= 12) return { month: n };
  }
  return null;
}

/**
 * Extract a month reference from free text.
 * Handles "July 2026", "2026-07", "last month", "this month", "in July".
 * @param {string} text
 * @param {Date} [now]
 * @returns {{ year: number, month: number, source: string }|null}
 */
function findMonthInText(text, now) {
  const t = String(text || '');
  if (!t.trim()) return null;

  const iso = t.match(/\b(\d{4})[-/](0?[1-9]|1[0-2])\b/);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), source: iso[0] };
  }

  const named = new RegExp(`\\b${MONTH_NAME_PATTERN}\\b[\\s,]*(\\d{4})?`, 'i').exec(t);
  if (named) {
    const month = NAME_TO_NUMBER.get(named[1].toLowerCase());
    if (month) {
      if (named[2]) return { year: Number(named[2]), month, source: named[0].trim() };
      // Bare month name: assume the most recent occurrence of that month.
      const cur = currentMonth(now);
      const year = month <= cur.month ? cur.year : cur.year - 1;
      return { year, month, source: named[1] };
    }
  }

  const yearFirst = new RegExp(`\\b(\\d{4})\\s+${MONTH_NAME_PATTERN}\\b`, 'i').exec(t);
  if (yearFirst) {
    const month = NAME_TO_NUMBER.get(yearFirst[2].toLowerCase());
    if (month) return { year: Number(yearFirst[1]), month, source: yearFirst[0] };
  }

  if (/\b(last|previous|prev|past)\s+month\b/i.test(t)) {
    const prev = shiftMonth(currentMonth(now), -1);
    return { ...prev, source: 'last month' };
  }
  if (/\b(this|current)\s+month\b/i.test(t)) {
    return { ...currentMonth(now), source: 'this month' };
  }

  return null;
}

/**
 * Resolve a month from task/tool payload fields plus optional free text.
 * Falls back to the current month.
 *
 * @param {{ month?: string|number, year?: string|number, text?: string, now?: Date }} [opts]
 */
function resolveMonth(opts = {}) {
  const { text, now } = opts;
  let year = opts.year != null && opts.year !== '' ? Number(opts.year) : null;
  let month = null;

  if (opts.month != null && opts.month !== '') {
    const raw = String(opts.month).trim();
    const relative = findRelative(raw, now);
    if (relative) {
      year = relative.year;
      month = relative.month;
    } else {
      const parsed = parseMonthToken(raw) || findMonthInText(raw, now);
      if (!parsed) {
        throw new Error(
          `Could not understand month "${raw}" — use YYYY-MM (e.g. 2026-07) or "July 2026"`
        );
      }
      if (parsed.year != null) year = parsed.year;
      if (parsed.month != null) month = parsed.month;
    }
  }

  if (month == null && text) {
    const fromText = findMonthInText(text, now);
    if (fromText) {
      month = fromText.month;
      if (year == null) year = fromText.year;
    }
  }

  if (month == null) {
    const cur = currentMonth(now);
    if (year == null || year === cur.year) {
      return { ...monthRange(cur.year, cur.month), defaulted: true };
    }
    throw new Error(`Specify a month for ${year} (e.g. ${year}-07)`);
  }

  if (year == null) {
    const cur = currentMonth(now);
    year = month <= cur.month ? cur.year : cur.year - 1;
  }

  return { ...monthRange(year, month), defaulted: false };
}

function findRelative(raw, now) {
  if (/^(last|previous|prev|past)[\s-]?month$/i.test(raw)) {
    return shiftMonth(currentMonth(now), -1);
  }
  if (/^(this|current)[\s-]?month$/i.test(raw)) {
    return currentMonth(now);
  }
  return null;
}

/**
 * Does this text ask for a period activity report ("what did I do in July")?
 * Requires an activity phrase; month reference is returned when present.
 * @param {string} text
 * @param {Date} [now]
 */
function looksLikeMonthlyActivity(text, now) {
  const t = String(text || '');
  if (!t.trim()) return null;

  const activity =
    /\b(activity|activities|what\s+(did|have)\s+i\s+(do|done|work(ed)?\s+on)|work\s*log|worklog|timesheet|contributions?|month(ly)?\s+(report|summary|recap|review)|recap)\b/i.test(
      t
    );
  if (!activity) return null;

  const monthRef = findMonthInText(t, now);
  const periodWord =
    monthRef != null || /\b(month|monthly|last\s+month|this\s+month)\b/i.test(t);
  if (!periodWord) return null;

  return { monthRef: monthRef || null };
}

/**
 * CLI helper: pull a month plus leftover flags out of argv.
 * Accepts "2026-07", "July 2026", "--month 2026-07", "last month".
 * @param {string[]} argv
 */
function parseMonthArgs(argv = []) {
  const rest = [];
  const words = [];
  let monthOpt = null;

  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];

    if (t === '--month' || t === '-m') {
      monthOpt = argv[++i];
      if (!monthOpt) throw new Error(`${t} requires a value like 2026-07`);
      continue;
    }
    if (t.startsWith('--month=')) {
      monthOpt = t.slice('--month='.length);
      continue;
    }
    if (t === '--last-month') {
      monthOpt = 'last month';
      continue;
    }
    if (t.startsWith('-') && t !== '-') {
      rest.push(t);
      continue;
    }
    words.push(t);
  }

  const phrase = words.join(' ').trim();
  const resolved = monthOpt
    ? resolveMonth({ month: monthOpt })
    : phrase
      ? resolveMonth({ month: phrase })
      : resolveMonth({});

  return { ...resolved, rest };
}

function printMonthUsage(command) {
  console.error(`Usage: ${command} [YYYY-MM | "Month YYYY" | last month] [options]

Examples:
  ${command} 2026-07
  ${command} July 2026
  ${command} --month 2026-07
  ${command} --last-month
  ${command}            # defaults to the current month
`);
}

module.exports = {
  MONTH_NAMES,
  monthRange,
  resolveMonth,
  parseMonthToken,
  findMonthInText,
  looksLikeMonthlyActivity,
  parseMonthArgs,
  printMonthUsage,
};
