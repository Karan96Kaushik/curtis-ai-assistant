import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveBehaviorProposal, type BehaviorContextRef } from '../../../lib/contexts/behaviorTarget.js';
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

const groq = aiRouter as unknown as GroqChat & {
  modelSwitchNotice(): string | null;
};

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

function parseProposal(raw: string, existing: readonly BehaviorContextRef[]) {
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
  try {
    return resolveBehaviorProposal(parsed as { action?: unknown; slug?: unknown; title?: unknown; summary?: unknown; content?: unknown }, existing);
  } catch (err) {
    throw new HttpError(502, err instanceof Error ? err.message : 'The model did not return a behavior proposal');
  }
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

  const existing = await db.from('contexts').select('slug, title, kind, content');
  if (existing.error) {
    if (contextsTableMissing(existing.error)) {
      throw new HttpError(503, 'Behavior memory needs the contexts table. Run supabase/migrations/0002_contexts.sql in the Supabase SQL editor.');
    }
    throw new HttpError(502, 'Could not load behavior memory');
  }
  const contexts = ((existing.data ?? []) as BehaviorContextRef[]).filter(
    (row) => row.kind === 'behavior' || row.kind === 'reference'
  );
  const behaviors = contexts.filter((row) => row.kind === 'behavior');

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
        'You extract one durable behavior context from a chat so an assistant can follow this user later.',
        'Return a JSON object with fields action, slug, title, summary, and content.',
        'action: "update" to fold into an existing behavior context, or "create" for a new one.',
        'Choose update when the new rule is the same topic as an existing behavior title. Otherwise create.',
        'Decide from the titles. Do not merge unrelated topics into one document.',
        'slug: the existing behavior slug when updating. When creating, a new lowercase hyphenated slug that is not already used.',
        'title: the existing title when updating, or a short new title (max 120 characters) that does not duplicate a title.',
        'summary: 1–3 sentences naming the title you chose and what you added, changed, or that nothing durable was found.',
        'content: the full markdown for that one context only. On update this replaces that context. On create this is the new document.',
        '',
        'Include only standing preferences, requirements, tone, format, and always/never workflow rules.',
        'Do not store secrets, credentials, tokens, passwords, or private keys.',
        'Do not store one-off tasks, ticket numbers, or temporary status unless the user states a lasting rule.',
        'On update: keep rules that still apply, revise conflicts, drop rules the user clearly retracted.',
        'Use short headings and bullets. No preamble inside content.',
        'If the chat has nothing durable, return action "update" only when a behavior already exists and return its content unchanged. If none exist, return action "create" with an empty content string.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Existing context titles:',
        contexts.length
          ? contexts.map((row) => `- ${row.title} (${row.kind}${row.kind === 'behavior' ? `, slug ${row.slug}` : ''})`).join('\n')
          : '(none)',
        '',
        'Behavior contexts you may update:',
        behaviors.length
          ? behaviors
              .map((row) => `## ${row.title}\nslug: ${row.slug}\n\n${row.content.trim() || '(empty)'}`)
              .join('\n\n---\n\n')
          : '(none)',
        '',
        'Chat transcript:',
        '---',
        transcript,
        '---',
      ].join('\n'),
    },
  ]);

  const proposal = parseProposal(raw, contexts);
  const notice = groq.modelSwitchNotice();
  const summary = notice ? `${proposal.summary}\n\n${notice}` : proposal.summary;
  return json(200, {
    action: proposal.action,
    slug: proposal.slug,
    title: proposal.title,
    summary,
    content: proposal.content,
    previous: proposal.previous,
  });
}
