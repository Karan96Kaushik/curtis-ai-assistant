/**
 * Monthly timesheet draft (text only) built from Jira + GitHub monthly activity,
 * following context/timesheet-filing-spec.md.
 */

const jiraMonthlyActivityTask = require('./jiraMonthlyActivity');
const githubMonthlyActivityTask = require('./githubMonthlyActivity');
const { chat } = require('../integrations/aiRouter');
const { resolveMonth, MONTH_NAMES } = require('../util/monthRange');
const { ukParts } = require('../util/time');

const TZ = 'Europe/London';

const PROJECTS = {
  FPS: 'FPS - Internal Platform development',
  JLP: 'JLP/ Waitrose Customer projects',
  SLICED: 'GR - SLICED 2',
  WINCANTON: 'Wincanton',
  BKH: 'BKH - Bank holiday',
  ALZ: 'ALZ - Annual Leave',
};
const WORK_PROJECTS = [PROJECTS.FPS, PROJECTS.JLP, PROJECTS.SLICED, PROJECTS.WINCANTON];
const DEFAULT_PROJECT = PROJECTS.FPS;

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOURS_PER_DAY = 8;

const MAX_LINES_PER_DAY = 10;
const MAX_LINE_CHARS = 200;

const SPELLING_FIXES = [
  [/\bflextircity\b/gi, 'Flexitricity'],
  [/\bOpt(?:i)?m(?:i)?[sz]er\b/gi, 'Optimiser'],
  [/\bOptimizer\b/gi, 'Optimiser'],
  [/\bOptmiser\b/gi, 'Optimiser'],
  [/\bOptimser\b/gi, 'Optimiser'],
  [/\bOnbaorded\b/gi, 'Onboarded'],
  [/\bTom\s?tom\b/gi, 'TomTom'],
  [/\barchg\b/gi, 'architecture'],
];

const RULES = `
Projects (copy EXACTLY, including spacing):
- "${PROJECTS.FPS}": Optimiser, Nexus, cloning, dashboards, Grafana, internal platform/tooling. Default when unsure.
- "${PROJECTS.JLP}": FCMS, Overload Limiter (OL), JLP/Waitrose onboarding and integrations.
- "${PROJECTS.SLICED}": SLICED 2 grant project work.
- "${PROJECTS.WINCANTON}": Wincanton customer work.

Rules:
1. One project per day. Only split a day when it clearly had two distinct activities; a split day has exactly 2 entries (4h + 4h), usually the same project.
2. Description: 4-8 words, pattern [Past-tense verb] + [system] + [specific thing], e.g. "Released FCMS options generator v2.0.2", "Investigated FCMS PM route-allocation bug", "Updated overload limiter integration plan", "Implemented Optimiser v2 trigger flow".
3. Always name the system/component (Nexus, FCMS, Optimiser, Overload Limiter, Grafana, Webfleet, TomTom, Ford Pro...). Never a bare "Testing".
4. Capitalise the first word. No trailing full stop. British spelling ("Optimiser").
5. Work tends to run in blocks of several days on one project. For a day with no evidence, continue the surrounding work on the same project and set "inferred": true. Describe a plausible next step of that work (testing, review, validation, deployment, fixes) using "Continued"/"Progressed"/"Tested"/"Validated" etc.
6. Jargon is fine (OL, VOR, PM, env var, v2/v3, dev/prod). Do not invent ticket numbers.
7. Every description in the month must be different. Never reuse the same wording on two days, even across a run of inferred days.
`.trim();

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function utcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(iso, n) {
  const d = utcDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(iso) {
  return utcDate(iso).getUTCDay();
}

const UK_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function ukDateOf(at) {
  const t = Date.parse(at || '');
  if (Number.isNaN(t)) return null;
  return UK_DATE_FMT.format(new Date(t));
}

/** "18-Aug-26" */
function sheetDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${pad2(d)}-${MONTH_NAMES[m - 1].slice(0, 3)}-${String(y).slice(2)}`;
}

/** Anonymous Gregorian algorithm. */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(year, month, day);
}

function firstMonday(year, month) {
  let iso = isoDate(year, month, 1);
  while (dayOfWeek(iso) !== 1) iso = addDays(iso, 1);
  return iso;
}

function lastMonday(year, month) {
  let iso = isoDate(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
  while (dayOfWeek(iso) !== 1) iso = addDays(iso, -1);
  return iso;
}

/**
 * England & Wales bank holidays (regular rules incl. weekend substitutes).
 * One-off royal holidays are not included; pass them as extra bank holidays.
 * @returns {Map<string, string>} iso date → name
 */
function englandBankHolidays(year) {
  const out = new Map();
  const nextWeekday = (iso, taken) => {
    let d = iso;
    while (dayOfWeek(d) === 0 || dayOfWeek(d) === 6 || taken.has(d)) d = addDays(d, 1);
    return d;
  };

  out.set(nextWeekday(isoDate(year, 1, 1), out), "New Year's Day");
  const easter = easterSunday(year);
  out.set(addDays(easter, -2), 'Good Friday');
  out.set(addDays(easter, 1), 'Easter Monday');
  out.set(firstMonday(year, 5), 'Early May bank holiday');
  out.set(lastMonday(year, 5), 'Spring bank holiday');
  out.set(lastMonday(year, 8), 'Summer bank holiday');
  const xmas = nextWeekday(isoDate(year, 12, 25), out);
  out.set(xmas, 'Christmas Day');
  out.set(nextWeekday(isoDate(year, 12, 26), out), 'Boxing Day');
  return out;
}

/** "2026-08-12, 2026-08-14..2026-08-18" → Set of ISO dates within [start, end]. */
function parseDateList(raw, start, end) {
  const out = new Set();
  const items = Array.isArray(raw) ? raw : String(raw || '').split(/[,;\n]+/);
  for (const item of items) {
    const s = String(item || '').trim();
    if (!s) continue;
    const range = s.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|–|—|-(?=\s*\d{4}-))\s*(\d{4}-\d{2}-\d{2})$/i);
    const [from, to] = range ? [range[1], range[2]] : [s, s];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) continue;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (d >= start && d <= end) out.add(d);
    }
  }
  return out;
}

function clip(s, n = MAX_LINE_CHARS) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function pushDayLine(byDay, day, line) {
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(clip(line));
}

/** Jira: one line per issue per day, e.g. `JIRA P25-12 "Summary" [P25]: 2 comment, 1 change — detail`. */
function jiraEvidence(result, byDay) {
  for (const issue of result?.issues || []) {
    const perDay = new Map();
    for (const e of issue.activity || []) {
      const day = ukDateOf(e.at);
      if (!day) continue;
      if (!perDay.has(day)) perDay.set(day, []);
      perDay.get(day).push(e);
    }
    for (const [day, events] of perDay) {
      const kinds = {};
      for (const e of events) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
      const kindText = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
      const detail = events.find((e) => e.kind === 'comment' || e.kind === 'worklog')?.detail
        || events.find((e) => e.kind === 'change')?.detail
        || '';
      pushDayLine(
        byDay,
        day,
        `JIRA ${issue.key} "${issue.summary}" [${issue.project || '?'}${issue.type ? `/${issue.type}` : ''}]: ${kindText}${detail ? ` — ${clip(detail, 90)}` : ''}`
      );
    }
  }
}

/** GitHub: one line per repo per day with commit/PR titles. */
function githubEvidence(result, byDay) {
  for (const group of result?.repos || []) {
    const perDay = new Map();
    for (const e of group.activity || []) {
      const day = ukDateOf(e.at);
      if (!day) continue;
      if (!perDay.has(day)) perDay.set(day, []);
      perDay.get(day).push(e);
    }
    for (const [day, events] of perDay) {
      const commits = events.filter((e) => e.kind === 'commit');
      const others = events.filter((e) => e.kind !== 'commit');
      const parts = [];
      if (commits.length) {
        const titles = [...new Set(commits.map((e) => e.title))].slice(0, 3).map((t) => `"${clip(t, 50)}"`);
        parts.push(`${commits.length} commit(s): ${titles.join('; ')}`);
      }
      for (const e of others.slice(0, 3)) parts.push(`${e.kind} "${clip(e.title, 60)}"`);
      pushDayLine(byDay, day, `GH ${group.repo}: ${parts.join(' | ')}`);
    }
  }
}

function buildCalendar(period, { leave, extraBankHolidays, todayIso }) {
  const holidays = englandBankHolidays(period.year);
  for (const d of extraBankHolidays) holidays.set(d, 'Bank holiday');
  const days = [];
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) {
    const dow = dayOfWeek(d);
    let type = 'work';
    if (dow === 0 || dow === 6) type = 'weekend';
    else if (holidays.has(d)) type = 'bank_holiday';
    else if (leave.has(d)) type = 'leave';
    else if (d > todayIso) type = 'future';
    days.push({ date: d, dow: DOW[dow], type, holidayName: holidays.get(d) || null });
  }
  return days;
}

function parseJsonObject(text) {
  const s = String(text || '').trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new Error('Timesheet model did not return JSON');
  }
}

function matchProject(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return null;
  const exact = WORK_PROJECTS.find((p) => p.toLowerCase() === s);
  if (exact) return exact;
  if (/\bfps\b|internal platform/.test(s)) return PROJECTS.FPS;
  if (/\bjlp\b|waitrose/.test(s)) return PROJECTS.JLP;
  if (/sliced/.test(s)) return PROJECTS.SLICED;
  if (/wincanton/.test(s)) return PROJECTS.WINCANTON;
  return null;
}

const FPS_KEYWORDS = /\b(optimiser|nexus|clon(e|ed|ing)|dashboards?|grafana)\b/i;
const JLP_KEYWORDS = /\b(fcms|overload limiter|OL|jlp|waitrose)\b/i;

/** Spec §7 mapping, applied only when the description points to exactly one side. */
function projectFromKeywords(description) {
  const fps = FPS_KEYWORDS.test(description);
  const jlp = JLP_KEYWORDS.test(description);
  if (fps && !jlp) return PROJECTS.FPS;
  if (jlp && !fps) return PROJECTS.JLP;
  return null;
}

function cleanDescription(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
  for (const [re, fix] of SPELLING_FIXES) s = s.replace(re, fix);
  if (s) s = s[0].toUpperCase() + s.slice(1);
  return s;
}

function wordCount(s) {
  return String(s || '').split(/\s+/).filter(Boolean).length;
}

async function draftWorkingDays(workDays, evidenceByDay, { periodLabel, notes }) {
  if (!workDays.length) return { byDate: new Map(), notes: [] };

  const dayBlock = workDays
    .map((d) => {
      const lines = (evidenceByDay.get(d.date) || []).slice(0, MAX_LINES_PER_DAY);
      return [`## ${d.date} (${d.dow})`, ...(lines.length ? lines.map((l) => `- ${l}`) : ['- (no recorded activity)'])].join('\n');
    })
    .join('\n');

  const messages = [
    {
      role: 'system',
      content: [
        `You fill Karan Kaushik's monthly timesheet for ${periodLabel} from his Jira and GitHub activity.`,
        RULES,
        '',
        'Return ONLY JSON of this shape, with one item for EVERY date listed by the user:',
        '{"days":[{"date":"YYYY-MM-DD","entries":[{"project":"<exact project name>","description":"<4-8 words>"}],"inferred":false}],"notes":["<optional short caveat>"]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        notes ? `Extra context from Karan (takes priority over activity data):\n${notes}\n` : '',
        'Working days and their activity (JIRA = issue events, GH = GitHub repo events):',
        dayBlock,
      ].join('\n'),
    },
  ];

  const completion = await chat({
    messages,
    toolChoice: 'none',
    temperature: 0.2,
    responseFormat: { type: 'json_object' },
  });
  const parsed = parseJsonObject(completion.choices?.[0]?.message?.content);
  const byDate = new Map();
  for (const day of Array.isArray(parsed?.days) ? parsed.days : []) {
    if (day && typeof day.date === 'string') byDate.set(day.date.trim(), day);
  }
  const modelNotes = (Array.isArray(parsed?.notes) ? parsed.notes : [])
    .map((n) => clip(n, 200))
    .filter(Boolean)
    .slice(0, 5);
  return { byDate, notes: modelNotes };
}

/** Coerce the model's day into spec-compliant entries (exact project, 8h or 4+4). */
function normaliseDay(day, modelDay, previous, evidenceCount) {
  const raw = Array.isArray(modelDay?.entries) ? modelDay.entries : [];
  let entries = raw
    .map((e) => ({ project: matchProject(e?.project), description: cleanDescription(e?.description) }))
    .filter((e) => e.description)
    .slice(0, 2);

  let inferred = Boolean(modelDay?.inferred) || evidenceCount === 0;
  if (!entries.length) {
    inferred = true;
    entries = previous
      ? [{ project: previous.project, description: cleanDescription(`Continued ${previous.description.replace(/^\S+\s+/, '')}`) }]
      : [{ project: DEFAULT_PROJECT, description: 'Continued internal platform development work' }];
  }

  const fallbackProject = previous?.project || DEFAULT_PROJECT;
  const hours = entries.length === 2 ? [4, 4] : [HOURS_PER_DAY];
  return {
    ...day,
    inferred,
    entries: entries.map((e, i) => {
      const project = e.project || fallbackProject;
      const mapped = projectFromKeywords(e.description);
      return {
        hours: hours[i],
        project: mapped && [PROJECTS.FPS, PROJECTS.JLP].includes(project) ? mapped : project,
        description: e.description,
      };
    }),
  };
}

function holidayRow(day, project, description) {
  return { ...day, inferred: false, entries: [{ hours: HOURS_PER_DAY, project, description }] };
}

/**
 * @param {{
 *   month?: string|number,
 *   year?: string|number,
 *   text?: string,
 *   leaveDates?: string|string[],
 *   bankHolidays?: string|string[],
 *   notes?: string,
 * }} [payload]
 */
async function timesheetDraftTask(payload = {}) {
  const period = resolveMonth({ month: payload.month, year: payload.year, text: payload.text });
  const today = ukParts();
  const todayIso = isoDate(today.year, today.month, today.day);
  if (period.start > todayIso) {
    throw new Error(`${period.label} has not started yet — nothing to fill.`);
  }

  const [jira, github] = await Promise.allSettled([
    jiraMonthlyActivityTask({ month: period.slug, detail: true }),
    githubMonthlyActivityTask({ month: period.slug }),
  ]);
  if (jira.status === 'rejected' && github.status === 'rejected') {
    throw new Error(
      `Could not load any activity for ${period.label}: Jira — ${jira.reason?.message || jira.reason}; GitHub — ${github.reason?.message || github.reason}`
    );
  }

  const sourceWarnings = [];
  const evidenceByDay = new Map();
  if (jira.status === 'fulfilled') jiraEvidence(jira.value, evidenceByDay);
  else sourceWarnings.push(`Jira activity unavailable: ${jira.reason?.message || jira.reason}`);
  if (github.status === 'fulfilled') githubEvidence(github.value, evidenceByDay);
  else sourceWarnings.push(`GitHub activity unavailable: ${github.reason?.message || github.reason}`);

  const days = buildCalendar(period, {
    leave: parseDateList(payload.leaveDates, period.start, period.end),
    extraBankHolidays: parseDateList(payload.bankHolidays, period.start, period.end),
    todayIso,
  });
  const workDays = days.filter((d) => d.type === 'work');

  const { byDate, notes: modelNotes } = await draftWorkingDays(workDays, evidenceByDay, {
    periodLabel: period.label,
    notes: String(payload.notes || '').trim(),
  });

  let previous = null;
  const rows = days.map((day) => {
    if (day.type === 'weekend' || day.type === 'future') return { ...day, inferred: false, entries: [] };
    if (day.type === 'bank_holiday') return holidayRow(day, PROJECTS.BKH, day.holidayName || 'Bank holiday');
    if (day.type === 'leave') return holidayRow(day, PROJECTS.ALZ, 'Annual leave');
    const row = normaliseDay(day, byDate.get(day.date), previous, (evidenceByDay.get(day.date) || []).length);
    previous = row.entries[row.entries.length - 1];
    return row;
  });

  const totalHours = rows.reduce((n, r) => n + r.entries.reduce((m, e) => m + e.hours, 0), 0);
  const workEntries = rows
    .filter((r) => r.type === 'work')
    .flatMap((r) => r.entries.map((e) => ({ date: r.date, description: e.description })));
  const descriptionsOutOfRange = workEntries.filter((e) => {
    const n = wordCount(e.description);
    return n < 4 || n > 8;
  });
  const seen = new Set();
  const repeatedDescriptions = workEntries.filter((e) => {
    const key = e.description.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });

  return {
    reportType: 'timesheet-draft',
    month: period.label,
    slug: period.slug,
    range: { start: period.start, end: period.end },
    monthDefaulted: Boolean(period.defaulted),
    rows,
    totalHours,
    counts: {
      workingDays: rows.filter((r) => r.type === 'work').length,
      bankHolidays: rows.filter((r) => r.type === 'bank_holiday').length,
      leaveDays: rows.filter((r) => r.type === 'leave').length,
      futureDays: rows.filter((r) => r.type === 'future').length,
      inferredDays: rows.filter((r) => r.inferred).length,
    },
    sources: {
      jira: jira.status === 'fulfilled' ? { issues: jira.value.issueCount, events: jira.value.eventCount } : null,
      github: github.status === 'fulfilled' ? { repos: github.value.repoCount, events: github.value.eventCount } : null,
    },
    descriptionsOutOfRange,
    repeatedDescriptions,
    warnings: [...sourceWarnings, ...modelNotes],
    generatedAt: new Date().toISOString(),
  };
}

/** Template: `DOW | Date | 8 | | | | 8 | Project | Description` (extra pairs for split days). */
function formatRow(row) {
  const hours = [0, 1, 2, 3].map((i) => (row.entries[i] ? String(row.entries[i].hours) : ''));
  const total = row.entries.reduce((n, e) => n + e.hours, 0);
  const pairs = row.entries.length
    ? row.entries.map((e) => `${e.project} | ${e.description}`).join(' | ')
    : ' | ';
  const mark = row.inferred ? ' *' : '';
  return `${row.dow} | ${sheetDate(row.date)} | ${hours.join(' | ')} | ${total} | ${pairs}${mark}`.replace(/\s+$/, '');
}

function formatResult(result) {
  const c = result.counts;
  const src = result.sources || {};
  const lines = [
    `**Timesheet — ${result.month}**${result.monthDefaulted ? ' (current month)' : ''}`,
    `Sources: ${src.jira ? `Jira ${src.jira.issues} issue(s)/${src.jira.events} event(s)` : 'Jira unavailable'} · ${src.github ? `GitHub ${src.github.repos} repo(s)/${src.github.events} event(s)` : 'GitHub unavailable'}`,
    '',
    '```text',
    'DOW | Date | Hours 1 | Hours 2 | Hours 3 | Hours 4 | Total | Project | Description',
    ...result.rows.map(formatRow),
    `TOTAL HOURS WORKED | ${result.totalHours}`,
    '```',
    `${c.workingDays} working day(s) × 8h${c.bankHolidays ? ` · ${c.bankHolidays} bank holiday(s)` : ''}${c.leaveDays ? ` · ${c.leaveDays} leave day(s)` : ''} = ${result.totalHours}h`,
  ];

  if (c.inferredDays) {
    lines.push(`\\* ${c.inferredDays} day(s) had no recorded activity and were inferred from surrounding work — check these.`);
  }
  if (c.futureDays) {
    lines.push(`${c.futureDays} working day(s) after today are left blank.`);
  }
  if (result.descriptionsOutOfRange?.length) {
    lines.push(
      `Outside the 4–8 word guideline: ${result.descriptionsOutOfRange.map((d) => sheetDate(d.date)).join(', ')}`
    );
  }
  if (result.repeatedDescriptions?.length) {
    lines.push(
      `Repeated wording (reword for audit): ${result.repeatedDescriptions.map((d) => sheetDate(d.date)).join(', ')}`
    );
  }
  for (const w of result.warnings || []) lines.push(`Note: ${w}`);
  lines.push('Tell me about leave days, one-off bank holidays or project corrections and I will redo the sheet.');
  return lines.join('\n');
}

module.exports = timesheetDraftTask;
module.exports.formatResult = formatResult;
module.exports.englandBankHolidays = englandBankHolidays;
module.exports.parseDateList = parseDateList;
module.exports.cleanDescription = cleanDescription;
module.exports.PROJECTS = PROJECTS;
