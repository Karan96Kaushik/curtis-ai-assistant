import { z } from 'zod';
import { PERMISSION_TOOLS } from '../../../../lib/agents/toolCatalog.js';
import {
  MAX_ACTIONS,
  MAX_ACTION_LABEL_CHARS,
  MAX_BODY_CHARS,
  MAX_DEEP_LINK_CHARS,
  MAX_EXPANDED_BODY_CHARS,
  MAX_KEY_CHARS,
  MAX_SHORT_CRITICAL_CHARS,
  MAX_SUBTITLE_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
  PUSH_ACTION_IDS,
  PUSH_CATEGORIES,
  PUSH_CHANNELS,
  PUSH_STYLES,
  PUSH_URGENCIES,
} from '../../../../lib/push/payload.js';
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
  summary: z
    .string()
    .min(1)
    .max(2000)
    .describe('Clear summary for the user: what you found, what matters, and any next steps'),
});

const scratchpad = z.object({
  text: z.string().max(800),
});

const searchFilters = {
  app: z
    .string()
    .max(80)
    .optional()
    .describe('App name or package fragment, e.g. WhatsApp, Gmail, com.whatsapp'),
  exclude_app: z.string().max(80).optional().describe('Omit this app or package from results'),
  sender: z.string().max(120).optional().describe('Notification title or chat/sender name'),
  text: z.string().max(200).optional().describe('Substring in title or body'),
  category: z.string().max(40).optional().describe('Android category fragment, e.g. msg, email, promo'),
  since: z.string().max(40).optional().describe('ISO start time. Default is 7 days ago (or hours, if set)'),
  until: z.string().max(40).optional().describe('ISO end time. Default is now'),
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .describe('Look back this many hours (1–168). Used when since is omitted'),
  limit: z.number().int().min(1).max(40).optional().describe('Max results, 1–40. Default 20'),
};

const searchNotifications = z.object(searchFilters);

const notificationAppStats = z.object({
  hours: z
    .number()
    .int()
    .min(1)
    .max(168)
    .optional()
    .describe('Look back this many hours (1–168). Default 24 when since is omitted'),
  since: z.string().max(40).optional().describe('ISO start time'),
  until: z.string().max(40).optional().describe('ISO end time. Default is now'),
});

const notificationDigest = z.object({
  since: z.string().min(1).max(40),
  group_by: z.enum(['app', 'sender']).optional(),
});

const getNotification = z.object({
  id: z.string().min(1).max(40),
});

const getMore = z.object({
  offset: z.number().int().min(0).max(2000).describe('Skip this many matches from a previous search'),
  ...searchFilters,
});

const draftReply = z.object({
  notification_id: z.string().min(1).max(40),
  body: z.string().min(1).max(1500),
});

const pushSend = z.object({
  title: z.string().min(1).max(MAX_TITLE_CHARS).describe('Short lock-screen title'),
  body: z.string().min(1).max(MAX_BODY_CHARS).describe('Primary notification text'),
  subtitle: z
    .string()
    .max(MAX_SUBTITLE_CHARS)
    .optional()
    .describe('Header subtext, e.g. Jira · PROJ-123'),
  expanded_body: z
    .string()
    .max(MAX_EXPANDED_BODY_CHARS)
    .optional()
    .describe('Longer text shown when the shade expands (BigText)'),
  category: z
    .enum(PUSH_CATEGORIES)
    .optional()
    .describe('Semantic category for Android CATEGORY_* mapping'),
  channel: z
    .enum(PUSH_CHANNELS)
    .optional()
    .describe('Notification channel: urgent, default, digest, progress, quiet'),
  urgency: z
    .enum(PUSH_URGENCIES)
    .optional()
    .describe('Interrupt level. Prefer channel when both are set'),
  silent: z.boolean().optional().describe('Post without sound/heads-up (digests)'),
  notification_key: z
    .string()
    .min(1)
    .max(MAX_KEY_CHARS)
    .optional()
    .describe('Stable id so later pushes replace this alert instead of stacking'),
  group_key: z
    .string()
    .min(1)
    .max(MAX_KEY_CHARS)
    .optional()
    .describe('Bundle related alerts in the shade'),
  deep_link: z
    .string()
    .min(1)
    .max(MAX_DEEP_LINK_CHARS)
    .optional()
    .describe('App path or URL to open on tap, e.g. /agents/runs/{id}'),
  image_url: z
    .string()
    .max(MAX_URL_CHARS)
    .optional()
    .describe('https image for BigPicture / expanded media'),
  large_icon_url: z
    .string()
    .max(MAX_URL_CHARS)
    .optional()
    .describe('https URL for large icon / avatar'),
  related_notification_id: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('Inbound phone notification id this alert refers to'),
  when: z.string().max(40).optional().describe('ISO time shown / sort key for the event'),
  expires_at: z.string().max(40).optional().describe('ISO time after which the app should auto-dismiss'),
  only_alert_once: z
    .boolean()
    .optional()
    .describe('Update content without re-buzzing (default true when notification_key set)'),
  style: z
    .enum(PUSH_STYLES)
    .optional()
    .describe('default | big_text | big_picture | progress'),
  progress: z
    .object({
      current: z.number().int().min(0).max(10_000),
      max: z.number().int().min(1).max(10_000),
      indeterminate: z.boolean().optional(),
    })
    .optional()
    .describe('Required when style is progress'),
  short_critical_text: z
    .string()
    .max(MAX_SHORT_CRITICAL_CHARS)
    .optional()
    .describe('Short status-bar chip text for Live Updates (Android 16)'),
  ongoing: z.boolean().optional().describe('Ongoing / sticky notification (progress journeys)'),
  request_promoted: z
    .boolean()
    .optional()
    .describe('Request Live Update promotion (requires ongoing; Android 16+)'),
  actions: z
    .array(
      z.object({
        id: z.enum(PUSH_ACTION_IDS),
        label: z.string().min(1).max(MAX_ACTION_LABEL_CHARS),
      })
    )
    .max(MAX_ACTIONS)
    .optional()
    .describe('Up to 3 action buttons (open, snooze, mark_done, open_draft, view_issue)'),
  data: z
    .record(z.string(), z.string())
    .optional()
    .describe('Optional extra string map for the app (do not use curtis_* keys)'),
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
    description:
      'Complete the run. summary must be a clear user-facing write-up of findings and next steps (not just "done").',
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
    name: 'notification_app_stats',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description:
      'Per-app notification counts for a time window (hours, or since/until). Default last 24 hours. Call this before search_notifications to see which apps are active.',
    schema: notificationAppStats,
    maxResultChars: 2500,
    handler: async (args, ctx) => {
      const parsed = notificationAppStats.parse(args);
      const result = await ctx.notifications.appStats(ctx.userId, ctx.allowedApps, parsed, ctx.now);
      return { text: result.text };
    },
  },
  {
    name: 'search_notifications',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description:
      'Search phone notification previews. Call notification_app_stats first unless you already have counts for this window. Filter by app, exclude_app, sender, text, category, since/until or hours (1–168). Default window is 7 days, default limit 20, max 40. Not full messages.',
    schema: searchNotifications,
    maxResultChars: 6000,
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
    description: 'Fetch the next page of a previous search_notifications query. Pass the same filters plus offset.',
    schema: getMore,
    maxResultChars: 6000,
    handler: async (args, ctx) => {
      const parsed = getMore.parse(args);
      const result = await ctx.notifications.search(
        ctx.userId,
        ctx.allowedApps,
        {
          app: parsed.app,
          exclude_app: parsed.exclude_app,
          sender: parsed.sender,
          text: parsed.text,
          category: parsed.category,
          since: parsed.since,
          until: parsed.until,
          hours: parsed.hours,
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
          subtitle: link.channel,
          category: 'msg',
          channel: 'default',
          urgency: 'normal',
          notification_key: `draft:${row.id}`,
          deep_link: link.link,
          related_notification_id: String(row.id),
          actions: [
            { id: 'open_draft', label: 'Open draft' },
            { id: 'open', label: 'Open run' },
          ],
          data: { link: link.link, run_id: ctx.runId, notification_id: String(row.id), reply_channel: link.channel },
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
    description:
      'Send a push to this user\'s Android app. Prefer a short title, useful body, and a stable notification_key so updates replace prior alerts. ' +
      'Use channel/urgency for interrupt level, deep_link to open the right screen, optional actions (Open/Snooze/Done), and style progress only for ongoing work. ' +
      'Do not spam: one key per event; update instead of stacking.',
    schema: pushSend,
    maxResultChars: 200,
    handler: async (args, ctx) => {
      const parsed = pushSend.parse(args);
      const result = await sendPushToUser(ctx.userId, parsed);
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
