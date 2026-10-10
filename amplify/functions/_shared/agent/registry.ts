import { z } from 'zod';
import { PERMISSION_TOOLS } from '../../../../lib/agents/toolCatalog.js';
import { sendPushToUser } from '../fcm.js';
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

const phoneNotifications = z.object({
  duration_minutes: z.number().int().min(1).max(24 * 60),
});

const pushSend = z.object({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(500),
});

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
    name: 'request_phone_notifications',
    integration: 'phone',
    access: 'read',
    risk: 'low',
    description: 'Read this user\'s recent phone notifications, including mail, codes, and personal messages.',
    schema: phoneNotifications,
    maxResultChars: 4000,
    handler: async (args, ctx) => {
      const parsed = phoneNotifications.parse(args);
      const cutoff = Date.now() - parsed.duration_minutes * 60_000;
      const items = (await ctx.email.list(ctx.userId, undefined, 40)).filter(
        (item) => Date.parse(item.postedAt) >= cutoff
      );
      const text = items.length
        ? items
            .slice(0, 20)
            .map((item) => `${item.id} | ${item.sender} | ${item.subject} | ${item.snippet}`)
            .join('\n')
        : 'No phone notifications in that window.';
      return { text };
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
    outbound: tool.outbound,
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
