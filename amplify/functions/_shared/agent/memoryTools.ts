import { z } from 'zod';
import orgMemory from '../../../../src/ai/orgMemory.js';
import storedContexts from '../../../../src/ai/storedContexts.js';
import type { ToolDef } from './types.js';

const memory = orgMemory as {
  read: () => string;
  write: (content: string) => void;
  append: (text: string) => { skipped?: boolean; reason?: string; appended?: string };
  getPath: () => string;
  formatWriteResult: (info: { action: string; appended?: string }) => string;
};

const contexts = storedContexts as {
  listEntries: () => { slug: string; title: string }[];
  readBySlug: (slug: string) => string;
  clip: (body: string) => string;
};

/** Org memory + stored contexts (paths from ORG_MEMORY_PATH / CURTIS_STATE_DIR). */
export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: 'memory_read',
    integration: 'memory',
    access: 'read',
    risk: 'low',
    description: 'Read org-memory.md.',
    schema: z.object({
      max_chars: z.coerce.number().int().min(200).max(12000).optional(),
    }),
    maxResultChars: 12000,
    handler: async (args) => {
      const maxChars = Math.min(Math.max(Number(args.max_chars) || 4000, 200), 12000);
      const full = memory.read();
      const body = full.length <= maxChars ? full : `…(truncated)\n${full.slice(-maxChars)}`;
      return {
        text: [
          `Org memory path: ${memory.getPath()}`,
          `Bytes: ${Buffer.byteLength(full, 'utf8')}`,
          '',
          body || '(empty)',
        ].join('\n'),
      };
    },
  },
  {
    name: 'context_list',
    integration: 'memory',
    access: 'read',
    risk: 'low',
    description: 'List stored reference contexts.',
    schema: z.object({}),
    maxResultChars: 4000,
    handler: async () => {
      const rows = contexts.listEntries();
      return {
        text: rows.length
          ? ['Stored contexts:', ...rows.map((row) => `- ${row.slug}: ${row.title}`)].join('\n')
          : 'No stored contexts.',
      };
    },
  },
  {
    name: 'context_read',
    integration: 'memory',
    access: 'read',
    risk: 'low',
    description: 'Read one stored reference context by slug (from context_list).',
    schema: z.object({
      slug: z.string().min(1).max(80),
    }),
    maxResultChars: 12000,
    handler: async (args) => {
      const slug = String(args.slug || '').trim();
      if (!slug) return { text: 'Error: context_read requires a slug. Call context_list first.' };
      try {
        const body = contexts.clip(contexts.readBySlug(slug));
        return {
          text: body.trim() ? `Context ${slug}:\n\n${body}` : `Context ${slug} is empty or not stored.`,
        };
      } catch (err) {
        return { text: `Error: context_read failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },
  {
    name: 'memory_append',
    integration: 'memory',
    access: 'write',
    risk: 'medium',
    description: 'Append durable org facts to org-memory.md.',
    schema: z.object({
      text: z.string().min(1).max(8000),
    }),
    maxResultChars: 4000,
    handler: async (args) => {
      const text = args.text != null ? String(args.text) : '';
      if (!text.trim()) return { text: 'Error: memory_append requires non-empty text' };
      try {
        const result = memory.append(text);
        if (result.skipped) {
          return {
            text: `Error: nothing appended — ${result.reason || 'empty after dedupe'}. Path: ${memory.getPath()}`,
          };
        }
        return { text: memory.formatWriteResult({ action: 'append', appended: result.appended }) };
      } catch (err) {
        return { text: `Error: memory_append failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },
  {
    name: 'memory_write',
    integration: 'memory',
    access: 'write',
    risk: 'medium',
    description: 'Replace org-memory.md entirely.',
    schema: z.object({
      content: z.string().max(50000),
    }),
    maxResultChars: 4000,
    handler: async (args) => {
      const content = args.content != null ? String(args.content) : '';
      try {
        memory.write(content);
        return { text: memory.formatWriteResult({ action: 'write' }) };
      } catch (err) {
        return { text: `Error: memory_write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  },
];
