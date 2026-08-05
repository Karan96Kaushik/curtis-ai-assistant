const registry = require('../core/moduleRegistry');
const scheduler = require('../core/scheduler');
const { formatUK, nowForPrompt, TZ, ukParts } = require('../util/time');
const { looksLikeDeferredSchedule } = require('../util/scheduleIntent');

registry.register({
  id: 'scheduler',
  intent: (text) => {
    const t = String(text || '');
    if (looksLikeDeferredSchedule(t)) {
      return {
        domain: 'scheduler',
        mode: 'mutate',
        budget: 'fast',
        confidence: 'high',
        reason: 'schedule',
      };
    }
  },
  tools: [
    {
      type: 'function',
      function: {
        name: 'schedule_task',
        description: `Schedule an automated wake-up in ${TZ}. For relative times like "in 3 minutes", prefer run_in_minutes. For clock times, use run_at. For recurring, use cron. Provide exactly one of run_in_minutes, run_at, or cron.`,
        parameters: {
          type: 'object',
          properties: {
            run_in_minutes: {
              type: 'number',
              description: 'Minutes from now (UK time). Use for "in N minutes/hours" (hours → minutes).',
            },
            run_at: {
              type: 'string',
              description: `UK local datetime for a single run. Prefer "YYYY-MM-DDTHH:mm:ss" WITHOUT Z (treated as ${TZ}/BST).`,
            },
            cron: {
              type: 'string',
              description: `Cron expression in ${TZ} (e.g. "0 9 * * *" = every day at 09:00 BST/GMT).`,
            },
            prompt: {
              type: 'string',
              description:
                'Full instruction for the bot to execute when it wakes (e.g. "Fetch my unresolved Jira issues and DM me a concise work agenda summary. Do not list every issue key unless useful."). Include any Jira/web/action the user wanted deferred.',
            },
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_schedules',
        description: 'List all currently active pending and recurring schedules/reminders (times shown in BST/UK).',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_schedule',
        description: 'Cancel an active scheduled task by its ID.',
        parameters: {
          type: 'object',
          properties: {
            job_id: { type: 'string', description: 'The ID of the scheduled job to cancel.' },
          },
          required: ['job_id'],
        },
      },
    },
  ],
  toolHandlers: {
    schedule_task: async (args) => {
      try {
        let runAt = args.run_at;
        if (args.run_in_minutes != null && args.run_in_minutes !== '') {
          const mins = Number(args.run_in_minutes);
          if (!Number.isFinite(mins) || mins < 0) {
            throw new Error('run_in_minutes must be a non-negative number');
          }
          runAt = new Date(Date.now() + mins * 60_000).toISOString();
        }
        if (!runAt && !args.cron) {
          throw new Error('Must provide run_in_minutes, run_at, or cron');
        }
        const job = scheduler.addJob({
          runAt,
          cron: args.cron,
          prompt: args.prompt,
        });
        const when = formatUK(job.runAt);
        const msg = args.cron
          ? `Recurring schedule set (${args.cron}, ${TZ}). Next run: ${when}`
          : `Single action scheduled for ${when}.`;
        return {
          text: `${msg} Prompt: "${job.prompt}"`,
          envelope: { ok: true, source: 'scheduler', confidence: 'high', data: { ...job, displayAt: when } },
        };
      } catch (err) {
        return {
          text: `Failed to schedule task: ${err.message}`,
          envelope: { ok: false, source: 'scheduler', confidence: 'high', data: null, error: err.message },
        };
      }
    },
    list_schedules: async () => {
      const jobs = scheduler.listJobs();
      if (jobs.length === 0) {
        return {
          text: 'No pending schedules found.',
          envelope: { ok: true, source: 'scheduler', confidence: 'high', data: [] },
        };
      }
      const text = jobs.map((j) => scheduler.formatJobLine(j)).join('\n');
      return { text, envelope: { ok: true, source: 'scheduler', confidence: 'high', data: jobs } };
    },
    cancel_schedule: async (args) => {
      const success = scheduler.cancelJob(args.job_id);
      if (success) {
        return {
          text: `Successfully cancelled schedule ${args.job_id}`,
          envelope: { ok: true, source: 'scheduler', confidence: 'high', data: { cancelled: args.job_id } },
        };
      }
      return {
        text: `Failed to cancel. Job ${args.job_id} not found or not pending.`,
        envelope: { ok: false, source: 'scheduler', confidence: 'high', data: null },
      };
    },
  },
  promptPack: () => {
    const now = nowForPrompt();
    const p = ukParts();
    return [
      'Scheduler mode (CRITICAL):',
      `- TIMEZONE: ${TZ}. Current: ${now}`,
      '- The user wants a FUTURE action. Do NOT run jira_my_issues / web tools now.',
      '- ONLY call schedule_task (or list/cancel). Put the deferred work inside schedule_task.prompt.',
      '- Examples:',
      '  · "send me my jira summary in 3 minutes" → schedule_task({ run_in_minutes: 3, prompt: "Fetch my unresolved Jira issues and DM me a concise work agenda summary." })',
      '  · "jira summary as a message in 5 minutes" → same pattern with run_in_minutes: 5',
      `- For clock times, use run_at as naive local "YYYY-MM-DDTHH:mm:ss" (no Z). Today is ${p.isoLocal.slice(0, 10)}.`,
      '- Confirm the scheduled UK/BST time to the user after the tool succeeds.',
    ].join('\n');
  },
  buildPlan: (intent, userText, opts, pushTool, pushGuidance) => {
    if (intent.domain === 'scheduler') {
      const text = String(userText).toLowerCase();
      if (/\bcancel\b/.test(text) && !/\bschedule\b/.test(text)) {
        // bare "cancel" may be jira pending — only list cancel_schedule when schedule-ish
        if (/\b(schedule|reminder|job)\b/.test(text) || looksLikeDeferredSchedule(userText)) {
          pushTool('cancel_schedule', 'Cancel a scheduled task');
          return;
        }
      }
      if (/\b(list|show)\b/.test(text) && /\bschedule/.test(text)) {
        pushTool('list_schedules', 'Check currently scheduled tasks');
        return;
      }
      pushTool('schedule_task', 'Schedule the deferred action for later (do not run Jira/web now)');
      pushGuidance(
        'do_not_run_now',
        'Do not call jira_my_issues or other domain tools this turn — only schedule_task with the future prompt'
      );
    }
  },
  evidenceExtractor: (tool, envelope, text, out) => {
    if (tool === 'schedule_task' && envelope.ok) {
      const when = envelope.data.displayAt || formatUK(envelope.data.runAt);
      out.push({
        type: 'side_effect',
        value: `Scheduled task (ID: ${envelope.data.id}) for ${when}${envelope.data.cron ? ` repeating ${envelope.data.cron}` : ''}`,
      });
    } else if (tool === 'list_schedules' && envelope.ok) {
      out.push({ type: 'fact', value: `Active schedules: ${envelope.data.length} found.` });
      envelope.data.forEach((j) =>
        out.push({ type: 'fact', value: `Job ${j.id}: next run ${formatUK(j.runAt)}` })
      );
    } else if (tool === 'cancel_schedule' && envelope.ok) {
      out.push({ type: 'side_effect', value: `Cancelled schedule ${envelope.data.cancelled}` });
    }
  },
});
