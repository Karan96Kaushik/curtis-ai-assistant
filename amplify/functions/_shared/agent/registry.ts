import { z } from 'zod';
import { PERMISSION_TOOLS } from '../../../../lib/agents/toolCatalog.js';
import { sendPushToUser } from '../fcm.js';
import { formatSearchResult, replyLinkFromNotification } from './notificationStore.js';
import type { EmailDetail, EmailListItem, EmailReader, ModelTool, ProfileSnapshot, ToolDef } from './types.js';
import { capText, wrapUntrusted } from './text.js';

export const CORE_TOOLS = new Set(['ask_user', 'finish', 'update_scratchpad']);

const askUser = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().min(1).max(80)).max(6).optional(),
});

const finish = z.object({
  summary: z.string().min(1).max(2000),
});

const scratchpad = z.object({
  text: z.string().max(800),
});

const searchNotifications = z.object({
  app: z.string().max(80).optional(),
  sender: z.string().max(120).optional(),
  text: z.string().max(200).optional(),
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const notificationDigest = z.object({
  since: z.string().min(1).max(40),
  group_by: z.enum(['app', 'sender']).optional(),
});

const getNotification = z.object({
  id: z.string().min(1).max(40),
});

const getMore = z.object({
  offset: z.number().int().min(0).max(500),
  app: z.string().max(80).optional(),
  sender: z.string().max(120).optional(),
  text: z.string().max(200).optional(),
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const draftReply = z.object({
  notification_id: z.string().min(1).max(40),
  body: z.string().min(1).max(1500),
});

const pushSend = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
});

const scheduleTask = z.object({
  run_in_minutes: z.number().min(0).max(365 * 24 * 60).optional(),
  run_at: z.string().min(1).max(40).optional(),
  cron: z.string().min(1).max(120).optional(),
  prompt: z.string().min(1).max(4000),
});

const cancelSchedule = z.object({
  job_id: z.string().min(1).max(80),
});

function scheduleFailure(err: unknown): { text: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { text: message.slice(0, 300) };
}

const unavailableArgs = z.object({
  input: z.string().max(500).optional(),
});

function parameters(schema: z.ZodType): Record<string, unknown> {
  const json = schema.toJSONSchema() as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Providers reject dots in function names. The registry keeps the dotted form. */
export function modelToolName(name: string): string {
  return name.replaceAll('.', '__');
}

export function registryToolName(name: string): string {
  if (name.includes('.')) return name;
  return name.replaceAll('__', '.');
}

const noop = async () => ({ text: '' });

export const TOOLS: ToolDef[] = [
  {
    name: 'ask_user',
    integration: 'core',
    access: 'read',
    risk: 'low',
    description: 'Pause and ask the user a clarifying question.',
    schema: askUser,
    maxResultChars: 2000,
    handler: noop,
  },
  {
    name: 'finish',
    integration: 'core',
    access: 'read',
    risk: 'low',
    description: 'Complete the run with a short summary for the user.',
    schema: finish,
    maxResultChars: 2000,
    handler: noop,
  },
  {
    name: 'update_scratchpad',
    integration: 'core',
    access: 'write',
    risk: 'low',
    description: 'Replace your working notes (plan, progress, and key IDs).',
    schema: scratchpad,
    maxResultChars: 200,
    handler: noop,
  },
  {
    name: 'search_notifications',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description: 'Search phone notification previews by app, sender, text, and time. Not full messages.',
    schema: searchNotifications,
    maxResultChars: 2500,
    handler: async (args, ctx) => {
      const parsed = searchNotifications.parse(args);
      const result = await ctx.notifications.search(ctx.userId, ctx.allowedApps, parsed, ctx.now);
      return { text: formatSearchResult(result.items, result.coverage, result.nextOffset) };
    },
  },
  {
    name: 'notification_digest',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description: 'Counts and top senders for a time window. Compact triage of notification previews.',
    schema: notificationDigest,
    maxResultChars: 1500,
    handler: async (args, ctx) => {
      const parsed = notificationDigest.parse(args);
      const result = await ctx.notifications.digest(
        ctx.userId,
        ctx.allowedApps,
        parsed.since,
        parsed.group_by ?? 'app',
        ctx.now
      );
      return { text: result.text };
    },
  },
  {
    name: 'get_notification',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description: 'Read the full stored text of one notification by id.',
    schema: getNotification,
    maxResultChars: 2500,
    handler: async (args, ctx) => {
      const parsed = getNotification.parse(args);
      const result = await ctx.notifications.get(ctx.userId, ctx.allowedApps, parsed.id, ctx.now);
      if (!result.item) return { text: `${result.coverage.text}\nNotification not found or not allowed for this profile.` };
      return {
        text: `${result.coverage.text}\nPreview (not a full message):\n${result.item.app} | ${result.item.sender}\n${result.body}`,
      };
    },
  },
  {
    name: 'list_notification_apps',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description: 'List apps that have notification rows this profile may query.',
    schema: z.object({}),
    maxResultChars: 1500,
    handler: async (_args, ctx) => {
      const result = await ctx.notifications.listApps(ctx.userId, ctx.allowedApps, ctx.now);
      const apps = result.apps.length ? result.apps.join('\n') : 'No apps in range for this profile.';
      return { text: `${result.coverage.text}\n${apps}` };
    },
  },
  {
    name: 'get_more',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description: 'Fetch the next page of a previous search_notifications query.',
    schema: getMore,
    maxResultChars: 2500,
    handler: async (args, ctx) => {
      const parsed = getMore.parse(args);
      const result = await ctx.notifications.search(
        ctx.userId,
        ctx.allowedApps,
        {
          app: parsed.app,
          sender: parsed.sender,
          text: parsed.text,
          since: parsed.since,
          until: parsed.until,
          limit: parsed.limit,
          offset: parsed.offset,
        },
        ctx.now
      );
      return { text: formatSearchResult(result.items, result.coverage, result.nextOffset) };
    },
  },
  {
    name: 'draft_reply',
    integration: 'phone',
    access: 'write',
    risk: 'low',
    description: 'Store a reply draft and a tap-to-open link. The user sends it; the agent cannot send messages.',
    schema: draftReply,
    maxResultChars: 800,
    handler: async (args, ctx) => {
      const parsed = draftReply.parse(args);
      const row = await ctx.notifications.loadForDraft(ctx.userId, ctx.allowedApps, parsed.notification_id);
      if (!row) return { text: 'Notification not found or not allowed. Contact must come from a stored notification.' };
      const link = replyLinkFromNotification(row, parsed.body);
      if (!link) {
        return {
          text: 'Could not build a reply link from the stored notification (no email or WhatsApp number in that row).',
        };
      }
      const preview = parsed.body.replace(/\s+/g, ' ').trim().slice(0, 140);
      try {
        await sendPushToUser(ctx.userId, {
          title: 'Draft reply ready',
          body: preview,
          data: { link: link.link, run_id: ctx.runId, notification_id: String(row.id), channel: link.channel },
        });
      } catch {
        // Draft still returned in the tool result for the run page.
      }
      return {
        text: `Draft stored for ${link.channel}. Open: ${link.link}\nYou send this yourself; the agent cannot send messages.`,
      };
    },
  },
  {
    name: 'send_push_notification',
    integration: 'push',
    access: 'write',
    risk: 'low',
    description: 'Send a push notification to this user\'s Android app.',
    schema: pushSend,
    maxResultChars: 200,
    handler: async (args, ctx) => {
      const parsed = pushSend.parse(args);
      const result = await sendPushToUser(ctx.userId, { title: parsed.title, body: parsed.body });
      return { text: result.sent ? `Push sent to ${result.sent} device(s).` : 'No devices are registered for push.' };
    },
  },
  {
    name: 'schedule_task',
    integration: 'scheduler',
    access: 'write',
    risk: 'medium',
    egress: true,
    description:
      'Schedule work for later. When it is due, a new agent run starts with this profile and the prompt. Use exactly one of run_in_minutes, run_at (UK local time), or cron.',
    schema: scheduleTask,
    maxResultChars: 800,
    handler: async (args, ctx) => {
      if (!ctx.schedule) return { text: 'Scheduling is not available.' };
      const parsed = scheduleTask.parse(args);
      try {
        const job = await ctx.schedule.schedule({
          userId: ctx.userId,
          profileId: ctx.profileId,
          prompt: parsed.prompt,
          runInMinutes: parsed.run_in_minutes,
          runAt: parsed.run_at,
          cron: parsed.cron,
          now: ctx.now.getTime(),
        });
        const when = job.cron ? `Recurring (${job.cron}). Next run ${job.displayAt}.` : `Scheduled for ${job.displayAt}.`;
        return { text: `${when} Job ${job.id}. A new agent run will start then. Prompt: ${job.prompt}` };
      } catch (err) {
        return scheduleFailure(err);
      }
    },
  },
  {
    name: 'list_schedules',
    integration: 'scheduler',
    access: 'read',
    risk: 'low',
    description: 'List this user\'s pending and running schedules, including chat schedules and agent schedules.',
    schema: z.object({}),
    maxResultChars: 2500,
    handler: async (_args, ctx) => {
      if (!ctx.schedule) return { text: 'Scheduling is not available.' };
      try {
        const jobs = await ctx.schedule.list(ctx.userId);
        if (!jobs.length) return { text: 'No pending schedules.' };
        const text = jobs
          .map((job) => {
            const kind = job.profileId ? 'Agent' : 'Chat';
            const when = job.cron ? `recurring ${job.cron}` : 'one-off';
            return `${job.id} | ${kind} | ${when} | ${job.status} | ${job.displayAt} | ${job.prompt}`;
          })
          .join('\n');
        return { text };
      } catch (err) {
        return scheduleFailure(err);
      }
    },
  },
  {
    name: 'cancel_schedule',
    integration: 'scheduler',
    access: 'write',
    risk: 'medium',
    description: 'Cancel a pending schedule by id. A job that is already running cannot be cancelled.',
    schema: cancelSchedule,
    maxResultChars: 300,
    handler: async (args, ctx) => {
      if (!ctx.schedule) return { text: 'Scheduling is not available.' };
      const parsed = cancelSchedule.parse(args);
      try {
        const cancelled = await ctx.schedule.cancel(ctx.userId, parsed.job_id);
        return { text: cancelled ? `Cancelled schedule ${parsed.job_id}.` : `Schedule ${parsed.job_id} was not pending.` };
      } catch (err) {
        return scheduleFailure(err);
      }
    },
  },
];

for (const tool of PERMISSION_TOOLS) {
  if (TOOLS.some((existing) => existing.name === tool.name)) continue;
  TOOLS.push({
    name: tool.name,
    integration: tool.integration,
    access: tool.access,
    risk: tool.risk,
    description: tool.description,
    schema: unavailableArgs,
    maxResultChars: 300,
    available: false,
    egress: tool.egress,
    handler: async () => ({ text: `${tool.name} is not connected yet.` }),
  });
}

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(registryToolName(name));
}

export function toolAllowed(profile: ProfileSnapshot, name: string): boolean {
  const registryName = registryToolName(name);
  if (CORE_TOOLS.has(registryName)) return true;
  return profile.allowed_tools.includes(registryName);
}

export function toolsForProfile(profile: ProfileSnapshot, tools: ToolDef[] = TOOLS): ToolDef[] {
  return tools.filter(
    (tool) => tool.available !== false && (CORE_TOOLS.has(tool.name) || profile.allowed_tools.includes(tool.name))
  );
}

export function toModelTools(tools: ToolDef[]): ModelTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: modelToolName(tool.name),
      description: tool.description,
      parameters: parameters(tool.schema),
    },
  }));
}

export function presentToolResult(tool: ToolDef, text: string, id: string): string {
  const capped = capText(text, tool.maxResultChars, tool.name);
  if (tool.integration === 'core') return capped;
  return wrapUntrusted(tool.name, id, capped);
}

export function knownToolNames(tools: ToolDef[] = TOOLS): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

export type { EmailDetail, EmailListItem, EmailReader };
