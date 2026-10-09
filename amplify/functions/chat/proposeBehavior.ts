import type { SupabaseClient } from '@supabase/supabase-js';
import { BEHAVIOR_SLUG, MAX_BEHAVIOR_CHARS } from '../../../lib/contexts/slugs.js';
import { redactSecrets } from '../../../lib/contexts/redact.js';
import aiRouter from '../../../src/integrations/aiRouter.js';
import { HttpError, json, type HttpResult } from '../_shared/http.js';
import { contextsTableMissing } from './contextSync.js';

interface GroqChoice {
  message?: { content?: string | null };
}

interface GroqResult {
  choices?: GroqChoice[];
}

interface GroqChat {
  chat(opts: {
    messages: { role: string; content: string }[];
    temperature?: number;
    responseFormat?: { type: string };
  }): Promise<GroqResult>;
}

const groq = aiRouter as unknown as GroqChat;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 2_000;

interface TranscriptRow {
  role: string;
  content: string;
}

function buildTranscript(rows: TranscriptRow[]): string {
  const lines = rows
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => {
      const speaker = row.role === 'user' ? 'User' : 'Curtis';
      const text = row.content.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS);
      return text ? `${speaker}: ${text}` : '';
    })
    .filter(Boolean);
  let text = lines.join('\n\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(-MAX_TRANSCRIPT_CHARS);
  return text;
}

function parseProposal(raw: string): { summary: string; content: string } {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new HttpError(502, 'The model did not return a behavior proposal');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new HttpError(502, 'The model did not return a behavior proposal');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(502, 'The model did not return a behavior proposal');
  }
  const record = parsed as { summary?: unknown; content?: unknown };
  const summary = typeof record.summary === 'string' ? record.summary.trim() : '';
  const content = typeof record.content === 'string' ? record.content : '';
  if (!summary) throw new HttpError(502, 'The model did not explain the behavior proposal');
  return {
    summary: summary.slice(0, 600),
    content: redactSecrets(content).trim().slice(0, MAX_BEHAVIOR_CHARS),
  };
}

async function complete(messages: { role: string; content: string }[]): Promise<string> {
  const base = { messages, temperature: 0.2 };
  let result: GroqResult;
  try {
    result = await groq.chat({ ...base, responseFormat: { type: 'json_object' } });
  } catch (err) {
    console.warn('[behavior] json mode failed, retrying:', err instanceof Error ? err.message : err);
    result = await groq.chat(base);
  }
  const text = result.choices?.[0]?.message?.content;
  if (!text?.trim()) throw new HttpError(502, 'The model returned an empty behavior proposal');
  return text;
}

/**
 * Read a chat and propose behavior memory. Does not write. The browser stores
 * the document only after the user approves it.
 */
export async function proposeBehavior(db: SupabaseClient, conversationId: string): Promise<HttpResult> {
  if (!UUID_RE.test(conversationId)) throw new HttpError(400, 'conversationId must be a UUID');

  const conversation = await db.from('conversations').select('id').eq('id', conversationId).maybeSingle();
  if (conversation.error) throw new HttpError(502, 'Could not load the conversation');
  if (!conversation.data) throw new HttpError(404, 'Conversation not found');

  const existing = await db.from('contexts').select('content').eq('slug', BEHAVIOR_SLUG).maybeSingle();
  if (existing.error) {
    if (contextsTableMissing(existing.error)) {
      throw new HttpError(503, 'Behavior memory needs the contexts table. Run supabase/migrations/0002_contexts.sql in the Supabase SQL editor.');
    }
    throw new HttpError(502, 'Could not load behavior memory');
  }
  const previous = typeof existing.data?.content === 'string' ? existing.data.content : '';

  const messages = await db
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (messages.error) throw new HttpError(502, 'Could not load the chat');

  const transcript = buildTranscript((messages.data ?? []) as TranscriptRow[]);
  if (!transcript.trim()) throw new HttpError(400, 'This chat has nothing to read yet');

  const raw = await complete([
    {
      role: 'system',
      content: [
        'You extract durable behavior memory from a chat so an assistant can follow this user later.',
        'Return a JSON object with two string fields: summary and content.',
        'summary: 1–3 sentences on what you added, changed, or that nothing durable was found.',
        'content: the full updated behavior memory in markdown. This replaces the previous document.',
        '',
        'Include only standing preferences, requirements, tone, format, and always/never workflow rules.',
        'Do not store secrets, credentials, tokens, passwords, or private keys.',
        'Do not store one-off tasks, ticket numbers, or temporary status unless the user states a lasting rule.',
        'Merge with the existing memory: keep rules that still apply, revise conflicts, drop rules the user clearly retracted.',
        'Use short headings and bullets. No preamble inside content.',
        'If the chat has nothing durable, return the existing content unchanged (or an empty string if there is none).',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Existing behavior memory:',
        '---',
        previous.trim() || '(none)',
        '---',
        '',
        'Chat transcript:',
        '---',
        transcript,
        '---',
      ].join('\n'),
    },
  ]);

  const proposal = parseProposal(raw);
  return json(200, { summary: proposal.summary, content: proposal.content, previous });
}
