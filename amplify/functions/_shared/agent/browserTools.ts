import { z } from 'zod';
import extensionBridge from '../../../../src/integrations/extensionBridge.js';
import type { ToolDef } from './types.js';

const bridge = extensionBridge as unknown as {
  isConnected: () => boolean;
  callSafe: (
    method: string,
    params?: Record<string, unknown>
  ) => Promise<{
    ok: boolean;
    result?: { text?: string; ok?: boolean; data?: unknown } | null;
    error?: string | null;
  }>;
};

const LOCAL_ONLY =
  'Firefox extension offline. Browser tools need the local Curtis Firefox add-on on the Discord bot host — they are not available in Amplify cloud agent runs.';

function offline(error?: string): { text: string } {
  return { text: error ? `${LOCAL_ONLY} (${error})` : LOCAL_ONLY };
}

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<{ text: string }> {
  if (!bridge.isConnected()) return offline('not connected');
  const { ok, result, error } = await bridge.callSafe(method, params);
  if (!ok) return offline(error ?? undefined);
  if (typeof result?.text === 'string') return { text: result.text };
  return { text: JSON.stringify(result ?? {}, null, 2) };
}

const optStr = z.string().max(2000).optional();
const optInt = z.coerce.number().int().optional();
const optBool = z.boolean().optional();

/**
 * Browser tools via the Firefox extension bridge.
 * In Amplify Lambdas the bridge is almost always offline; handlers return a clear message.
 */
export const BROWSER_TOOLS: ToolDef[] = [
  {
    name: 'browser_status',
    integration: 'browser',
    access: 'read',
    risk: 'low',
    description: 'Check whether the Firefox extension is connected (local Discord bot host only).',
    schema: z.object({}),
    maxResultChars: 1500,
    handler: async () => {
      if (!bridge.isConnected()) return offline('not connected');
      return rpc('browser.status');
    },
  },
  {
    name: 'browser_list_tabs',
    integration: 'browser',
    access: 'read',
    risk: 'low',
    description: 'List open Firefox tabs (local extension only).',
    schema: z.object({}),
    maxResultChars: 6000,
    handler: async () => rpc('browser.listTabs'),
  },
  {
    name: 'browser_read_page',
    integration: 'browser',
    access: 'read',
    risk: 'low',
    description: 'Read visible text from a Firefox tab (local extension only).',
    schema: z.object({
      tab_id: optInt,
      selector: optStr,
      max_chars: optInt,
    }),
    maxResultChars: 10000,
    handler: async (args) =>
      rpc('browser.readPage', {
        tabId: args.tab_id,
        selector: args.selector,
        maxChars: args.max_chars || 8000,
      }),
  },
  {
    name: 'browser_open_tab',
    integration: 'browser',
    access: 'write',
    risk: 'medium',
    description: 'Open a URL in Firefox or focus a matching tab (local extension only).',
    schema: z.object({
      url: z.string().min(1).max(2000),
      activate: optBool,
    }),
    maxResultChars: 2000,
    handler: async (args) =>
      rpc('browser.openTab', {
        url: args.url,
        activate: args.activate !== false,
      }),
  },
  {
    name: 'browser_navigate',
    integration: 'browser',
    access: 'write',
    risk: 'medium',
    description: 'Navigate a Firefox tab to a URL (local extension only).',
    schema: z.object({
      url: z.string().min(1).max(2000),
      tab_id: optInt,
    }),
    maxResultChars: 2000,
    handler: async (args) =>
      rpc('browser.navigate', {
        url: args.url,
        tabId: args.tab_id,
      }),
  },
  {
    name: 'browser_click',
    integration: 'browser',
    access: 'write',
    risk: 'high',
    description: 'Click an element in the active Firefox tab (local extension only).',
    schema: z.object({
      selector: optStr,
      text: optStr,
      tab_id: optInt,
    }),
    maxResultChars: 2000,
    handler: async (args) =>
      rpc('browser.click', {
        selector: args.selector,
        text: args.text,
        tabId: args.tab_id,
      }),
  },
  {
    name: 'browser_type',
    integration: 'browser',
    access: 'write',
    risk: 'high',
    egress: true,
    description: 'Type text into a field in the active Firefox tab (local extension only).',
    schema: z.object({
      selector: z.string().min(1).max(500),
      text: z.string().min(1).max(8000),
      clear: optBool,
      tab_id: optInt,
    }),
    maxResultChars: 2000,
    handler: async (args) =>
      rpc('browser.type', {
        selector: args.selector,
        text: args.text,
        clear: args.clear !== false,
        tabId: args.tab_id,
      }),
  },
];
