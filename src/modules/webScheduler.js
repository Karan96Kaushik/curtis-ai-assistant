const registry = require('../core/moduleRegistry');
const { TZ, nowForPrompt, ukParts } = require('../util/time');
const { looksLikeDeferredSchedule } = require('../util/scheduleIntent');

/** @type {null | { schedule: Function, list: Function, cancel: Function }} */
let api = null;
let registered = false;

function bind(next) {
  api = next;
}

function unavailable(message) {
  return {
    text: message,
    envelope: { ok: false, source: 'scheduler', confidence: 'high', data: null, error: message },
  };
}

function register() {
  if (registered) return;
  registered = true;
  registry.register({
    id: 'scheduler',
    intent: (text) => {
      if (looksLikeDeferredSchedule(text)) {
        return {
          domain: 'scheduler',
          mode: 'mutate',
          budget: 'fast',
          confidence: 'high',
          reason: 'schedule',
        };
      }
    },
    selectTools: (intent, ctx) =>
      intent.domain === 'scheduler' || ctx.fallback
        ? ['schedule_task', 'list_schedules', 'cancel_schedule']
        : [],
    tools: [
      {
        type: 'function',
        function: {
          name: 'schedule_task',
          description: `Schedule work for later in ${TZ}. The job is stored and run by the backend. When it fires, Curtis carries out the prompt, posts the reply in this chat, and sends a short phone push. Checks run about once a minute, so a task can start up to a minute after the scheduled time. For relative times like "in 3 minutes", use run_in_minutes. For a clock time, use run_at. For recurring, use cron and put only the work for each run in prompt. Provide exactly one of run_in_minutes, run_at, or cron.`,
          parameters: {
            type: 'object',
            properties: {
              run_in_minutes: {
                type: 'number',
                description: 'Minutes from now (UK time). Use for "in N minutes/hours" (hours → minutes).',
              },
              run_at: {
                type: 'string',
                description: `UK local datetime for a single run. Prefer "YYYY-MM-DDTHH:mm:ss" WITHOUT Z (treated as ${TZ}).`,
              },
              cron: {
                type: 'string',
                description: `Cron expression in ${TZ} (e.g. "0 9 * * 1-5" = weekdays at 09:00).`,
              },
              prompt: {
                type: 'string',
                description:
                  'What to do when the job runs. For a recurring job this is the work each time, not an instruction to schedule again.',
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
          description: 'List pending and running schedules for this user (times in UK local time).',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'cancel_schedule',
          description: 'Cancel a pending scheduled task by its ID. A job that is already running cannot be cancelled.',
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
        if (!api) return unavailable('Scheduling is not available in this session.');
        try {
          const job = await api.schedule({
            runInMinutes: args.run_in_minutes,
            runAt: args.run_at,
            cron: args.cron,
            prompt: args.prompt,
          });
          const msg = job.cron
            ? `Recurring schedule set (${job.cron}, ${job.timezone}). Next run: ${job.displayAt}.`
            : `Scheduled for ${job.displayAt}.`;
          return {
            text: `${msg} It will run in this chat and a short result will be pushed to the phone. Prompt: "${job.prompt}"`,
            envelope: { ok: true, source: 'scheduler', confidence: 'high', data: job },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return unavailable(`Failed to schedule task: ${message}`);
        }
      },
      list_schedules: async () => {
        if (!api) return unavailable('Scheduling is not available in this session.');
        try {
          const jobs = await api.list();
          if (!jobs.length) {
            return {
              text: 'No pending schedules found.',
              envelope: { ok: true, source: 'scheduler', confidence: 'high', data: [] },
            };
          }
          const text = jobs
            .map((job) => {
              const kind = job.cron ? `Recurring (${job.cron}, ${job.timezone})` : `One-off (${job.timezone})`;
              return `- [${job.id}] ${kind}. ${job.status}. Next: ${job.displayAt}\n  Prompt: ${job.prompt}`;
            })
            .join('\n');
          return { text, envelope: { ok: true, source: 'scheduler', confidence: 'high', data: jobs } };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return unavailable(`Failed to list schedules: ${message}`);
        }
      },
      cancel_schedule: async (args) => {
        if (!api) return unavailable('Scheduling is not available in this session.');
        try {
          const ok = await api.cancel(args.job_id);
          if (ok) {
            return {
              text: `Successfully cancelled schedule ${args.job_id}`,
              envelope: { ok: true, source: 'scheduler', confidence: 'high', data: { cancelled: args.job_id } },
            };
          }
          return unavailable(`Failed to cancel. Job ${args.job_id} was not found or is not pending.`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return unavailable(`Failed to cancel: ${message}`);
        }
      },
    },
    promptPack: () => {
      const now = nowForPrompt();
      const p = ukParts();
      return [
        'Scheduler mode (CRITICAL):',
        `- TIMEZONE: ${TZ}. Current: ${now}`,
        '- The user wants a FUTURE action. Do NOT run jira, github, or web tools now.',
        '- ONLY call schedule_task (or list/cancel). Put the deferred work inside schedule_task.prompt.',
        '- The backend runs the prompt later, posts the reply in this chat, and pushes a short version to the phone.',
        '- A run can start up to a minute after the scheduled time.',
        '- Examples:',
        '  · "send me my jira summary in 3 minutes" → schedule_task({ run_in_minutes: 3, prompt: "Fetch my unresolved Jira issues and reply with a concise work agenda." })',
        '  · "jira summary every weekday at 9" → schedule_task({ cron: "0 9 * * 1-5", prompt: "Fetch my unresolved Jira issues and reply with a concise work agenda." })',
        `- For clock times, use run_at as naive local "YYYY-MM-DDTHH:mm:ss" (no Z). Today is ${p.isoLocal.slice(0, 10)}.`,
        '- Confirm the scheduled UK time to the user after the tool succeeds.',
      ].join('\n');
    },
    buildPlan: (intent, userText, _opts, pushTool, pushGuidance) => {
      if (intent.domain !== 'scheduler') return;
      const text = String(userText).toLowerCase();
      if (/\bcancel\b/.test(text) && /\b(schedule|reminder|job)\b/.test(text)) {
        pushTool('cancel_schedule', 'Cancel a scheduled task');
        return;
      }
      if (/\b(list|show)\b/.test(text) && /\bschedule/.test(text)) {
        pushTool('list_schedules', 'Check currently scheduled tasks');
        return;
      }
      pushTool('schedule_task', 'Schedule the deferred action for later (do not run it now)');
      pushGuidance('do_not_run_now', 'Do not call other domain tools this turn — only schedule_task with the future prompt');
    },
    evidenceExtractor: (tool, envelope, _text, out) => {
      if (tool === 'schedule_task' && envelope.ok) {
        const when = envelope.data.displayAt;
        out.push({
          type: 'side_effect',
          value: `Scheduled task (ID: ${envelope.data.id}) for ${when}${envelope.data.cron ? ` repeating ${envelope.data.cron}` : ''}`,
        });
      } else if (tool === 'list_schedules' && envelope.ok) {
        out.push({ type: 'fact', value: `Active schedules: ${envelope.data.length} found.` });
        envelope.data.forEach((job) =>
          out.push({ type: 'fact', value: `Job ${job.id}: next run ${job.displayAt}` })
        );
      } else if (tool === 'cancel_schedule' && envelope.ok) {
        out.push({ type: 'side_effect', value: `Cancelled schedule ${envelope.data.cancelled}` });
      }
    },
  });
}

module.exports = { register, bind };
