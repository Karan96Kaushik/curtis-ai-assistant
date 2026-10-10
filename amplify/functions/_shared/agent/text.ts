import type { ChatMessage } from './types.js';

const SECRET = /sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._\-]+/gi;

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content?.length ?? 0;
    if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length;
  }
  return Math.ceil(chars / 3.5);
}

export function capText(text: string, max: number, toolName: string): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n[truncated: ${omitted} chars omitted. Use ${toolName}.get_more(id, offset) for the rest]`;
}

export function escapeUntrusted(content: string): string {
  return content.replace(/<\/untrusted_data/gi, '<\\/untrusted_data');
}

export function wrapUntrusted(source: string, id: string, content: string): string {
  const safeId = id.replace(/"/g, '');
  return `<untrusted_data source="${source}" id="${safeId}">\n${escapeUntrusted(content)}\n</untrusted_data>`;
}

export function preview(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export function redactValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    return JSON.parse(json.replace(SECRET, '[redacted]'));
  } catch {
    return {};
  }
}

export function sanitizeToolError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Tool failed';
  return message.replace(SECRET, '[redacted]').replace(/api[_-]?key|token|secret/gi, '[redacted]').slice(0, 300);
}
