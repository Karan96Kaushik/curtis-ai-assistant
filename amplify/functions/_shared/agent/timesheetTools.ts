import { z } from 'zod';
import timesheetDraftTask from '../../../../src/tasks/timesheetDraft.js';
import type { ToolDef } from './types.js';

type DraftTask = ((payload: object) => Promise<{
  rows: unknown[];
  totalHours: number;
}>) & {
  formatResult: (raw: unknown) => string;
};

const draft = timesheetDraftTask as DraftTask;

function toList(value: unknown): string {
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : '';
}

/** Monthly timesheet draft from Jira + GitHub activity. */
export const TIMESHEET_TOOLS: ToolDef[] = [
  {
    name: 'timesheet_draft',
    integration: 'timesheet',
    access: 'read',
    risk: 'low',
    description:
      'Draft the monthly timesheet as text rows (DOW | Date | hours | Total | Project | Description) for ONE calendar month. Pulls that month\'s Jira and GitHub activity itself. Output is shown to the user verbatim.',
    schema: z.object({
      month: z.string().max(80).optional(),
      leave_dates: z.string().max(500).optional(),
      bank_holidays: z.string().max(500).optional(),
      notes: z.string().max(4000).optional(),
    }),
    maxResultChars: 16000,
    handler: async (args) => {
      const raw = await draft({
        month: typeof args.month === 'string' && args.month.trim() ? args.month.trim() : undefined,
        leaveDates: toList(args.leave_dates),
        bankHolidays: toList(args.bank_holidays),
        notes: typeof args.notes === 'string' ? args.notes : '',
      });
      return { text: draft.formatResult(raw) };
    },
  },
];
