const registry = require('../core/moduleRegistry');
const timesheetDraftTask = require('../tasks/timesheetDraft');
const { findMonthInText } = require('../util/monthRange');
const { envelopeFromRaw } = require('../util/taskResult');
const { startTimer } = require('../util/timing');

const TIMESHEET_RE = /\btime\s*-?\s*sheets?\b/i;

function toList(value) {
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : '';
}

registry.register({
  id: 'timesheet',

  intent: (text) => {
    const t = String(text || '').trim();
    if (!TIMESHEET_RE.test(t)) return null;
    const monthRef = findMonthInText(t);
    return {
      domain: 'timesheet',
      mode: 'activity',
      budget: 'slow',
      confidence: 'high',
      reason: 'timesheet',
      forceTimesheet: true,
      monthRef: monthRef ? monthRef.source : null,
    };
  },

  selectTools: (intent, ctx) =>
    intent.domain === 'timesheet' || intent.forceTimesheet || ctx.fallback ? ['timesheet_draft'] : [],

  tools: [
    {
      type: 'function',
      function: {
        name: 'timesheet_draft',
        description:
          'Draft the monthly timesheet as text rows (DOW | Date | hours | Total | Project | Description) for ONE calendar month. Pulls that month\'s Jira and GitHub activity itself, codes weekends, UK bank holidays and annual leave, and writes spec-compliant descriptions. Output is shown to the user verbatim.',
        parameters: {
          type: 'object',
          properties: {
            month: {
              type: 'string',
              description:
                'Month as YYYY-MM (e.g. 2026-08), "August 2026", "last month", or "this month". Defaults to the current month.',
            },
            leave_dates: {
              type: 'string',
              description:
                'Annual leave days the user mentioned, as comma-separated ISO dates or ranges (2026-08-12, 2026-08-17..2026-08-19).',
            },
            bank_holidays: {
              type: 'string',
              description:
                'Extra one-off bank holidays the user mentioned (same format). Regular England & Wales bank holidays are added automatically.',
            },
            notes: {
              type: 'string',
              description:
                'Any other context the user gave about the month (projects worked on, corrections, what a given week was about). Copy it faithfully.',
            },
          },
        },
      },
    },
  ],

  tasks: {
    'timesheet-draft': {
      execute: timesheetDraftTask,
      format: timesheetDraftTask.formatResult,
    },
  },

  toolHandlers: {
    timesheet_draft: async (args) => {
      const timer = startTimer('task.timesheet-draft');
      try {
        const raw = await timesheetDraftTask({
          month: typeof args.month === 'string' && args.month.trim() ? args.month.trim() : undefined,
          leaveDates: toList(args.leave_dates),
          bankHolidays: toList(args.bank_holidays),
          notes: typeof args.notes === 'string' ? args.notes : '',
        });
        timer.end(`rows=${raw.rows.length} total=${raw.totalHours}`);
        return {
          text: timesheetDraftTask.formatResult(raw),
          envelope: envelopeFromRaw('timesheet-draft', raw),
          verbatim: true,
        };
      } catch (err) {
        timer.end('FAILED');
        throw err;
      }
    },
  },

  promptPack: () =>
    [
      'Timesheet mode:',
      '- Call timesheet_draft exactly once for the requested month. It fetches Jira + GitHub activity itself — do not call activity tools first.',
      '- Convert any leave the user mentions into ISO dates for leave_dates; one-off bank holidays go in bank_holidays.',
      '- Pass any other context about the month (projects, corrections, what they worked on) in notes.',
      '- The tool output is the reply. Never invent rows or produce files/spreadsheets — text only.',
    ].join('\n'),

  buildPlan: (intent, userText, opts, pushTool) => {
    if (intent.domain !== 'timesheet') return;
    pushTool(
      'timesheet_draft',
      `Draft the timesheet${intent.monthRef ? ` for ${intent.monthRef}` : ''} from Jira + GitHub activity`
    );
  },

  evidenceExtractor: (tool, envelope, text, out) => {
    if (tool !== 'timesheet_draft') return;
    const d = envelope.data || {};
    out.push({
      type: 'timesheet',
      month: d.month,
      totalHours: d.totalHours,
      workingDays: d.counts?.workingDays,
      inferredDays: d.counts?.inferredDays,
    });
  },
});
