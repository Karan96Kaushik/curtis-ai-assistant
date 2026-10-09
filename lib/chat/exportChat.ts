import { durationBeforeReply, formatResponseDuration } from '@/lib/chat/duration';
import { splitModelSwitch } from '@/src/integrations/modelCatalog.js';

export type ChatExportFormat = 'markdown' | 'json';

export interface ExportableMessage {
  role: string;
  content: string;
  created_at: string;
}

const ROLE_LABEL: Record<string, string> = {
  user: 'You',
  assistant: 'Curtis',
  error: 'Error',
};

function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function chatFileSlug(title: string): string {
  const base = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'chat';
}

function cleanMessage(content: string): { body: string; notice: string | null } {
  return splitModelSwitch(content);
}

export function buildChatExport(input: {
  title: string;
  messages: readonly ExportableMessage[];
  format: ChatExportFormat;
  exportedAt?: string;
}): { filename: string; mime: string; contents: string } {
  const title = input.title.trim() || 'Chat';
  const slug = chatFileSlug(title);
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const rows = input.messages.map((message, index) => {
    const cleaned = cleanMessage(message.content);
    const durationMs = durationBeforeReply(input.messages, index);
    return {
      role: message.role,
      label: roleLabel(message.role),
      createdAt: message.created_at,
      body: cleaned.body,
      notice: cleaned.notice,
      durationMs,
    };
  });

  if (input.format === 'json') {
    return {
      filename: `${slug}.json`,
      mime: 'application/json',
      contents: `${JSON.stringify(
        {
          title,
          exportedAt,
          messages: rows.map((row) => ({
            role: row.role,
            createdAt: row.createdAt,
            content: row.body,
            ...(row.notice ? { notice: row.notice } : {}),
            ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
          })),
        },
        null,
        2
      )}\n`,
    };
  }

  const parts = [`# ${title}`, '', `Exported ${formatWhen(exportedAt)}`, ''];
  for (const row of rows) {
    parts.push(`## ${row.label}`, '', formatWhen(row.createdAt));
    if (row.durationMs != null) parts.push(`Took ${formatResponseDuration(row.durationMs)}`);
    parts.push('', row.body.trim() || '(empty)', '');
    if (row.notice) parts.push(row.notice, '');
  }
  return {
    filename: `${slug}.md`,
    mime: 'text/markdown',
    contents: `${parts.join('\n').trim()}\n`,
  };
}

export function downloadChatExport(input: {
  title: string;
  messages: readonly ExportableMessage[];
  format: ChatExportFormat;
}): void {
  const file = buildChatExport(input);
  const blob = new Blob([file.contents], { type: `${file.mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  URL.revokeObjectURL(url);
}
