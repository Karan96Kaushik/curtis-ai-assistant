import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, json, parseBody, withHttp } from '../_shared/http.js';
import { enforceRateLimit } from '../_shared/rateLimit.js';
import { supabaseForCaller } from '../_shared/supabaseUser.js';
import { requireAllowedCaller, type AuthedCaller } from '../_shared/verifySupabaseAuth.js';
import {
  runAgentTurn,
  type AgentMessage,
  type StateFile,
  type StoredPendingAction,
} from './agentRuntime.js';

interface ChatRequest {
  conversationId: string | null;
  message: string;
}

interface ConversationRow {
  id: string;
  title: string;
  agent_history: AgentMessage[] | null;
  pending_action: StoredPendingAction | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  created_at: string;
}

const MAX_MESSAGE_CHARS = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_COLUMNS = 'id, title, agent_history, pending_action, created_at, updated_at';

function titleFromMessage(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
}

function dbError(action: string, error: { message: string }): HttpError {
  console.error(`[chat] ${action} failed:`, error.message);
  return new HttpError(502, `Could not ${action}`);
}

async function loadConversation(db: SupabaseClient, id: string): Promise<ConversationRow> {
  const { data, error } = await db
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw dbError('load the conversation', error);
  if (!data) throw new HttpError(404, 'Conversation not found');
  return data as ConversationRow;
}

async function createConversation(db: SupabaseClient, caller: AuthedCaller, text: string): Promise<ConversationRow> {
  const { data, error } = await db
    .from('conversations')
    .insert({ user_id: caller.userId, title: titleFromMessage(text) })
    .select(CONVERSATION_COLUMNS)
    .single();
  if (error) throw dbError('create a conversation', error);
  return data as ConversationRow;
}

async function insertMessage(
  db: SupabaseClient,
  caller: AuthedCaller,
  conversationId: string,
  role: MessageRow['role'],
  content: string
): Promise<MessageRow> {
  const { data, error } = await db
    .from('messages')
    .insert({ conversation_id: conversationId, user_id: caller.userId, role, content })
    .select('id, conversation_id, role, content, created_at')
    .single();
  if (error) throw dbError('save the message', error);
  return data as MessageRow;
}

async function loadFiles(db: SupabaseClient): Promise<StateFile[]> {
  const { data, error } = await db.from('agent_files').select('path, content');
  if (error) throw dbError('load agent memory', error);
  return (data ?? []) as StateFile[];
}

async function saveFiles(
  db: SupabaseClient,
  caller: AuthedCaller,
  changed: StateFile[],
  removed: string[]
): Promise<void> {
  if (changed.length) {
    const updatedAt = new Date().toISOString();
    const { error } = await db
      .from('agent_files')
      .upsert(changed.map((f) => ({ user_id: caller.userId, path: f.path, content: f.content, updated_at: updatedAt })));
    if (error) throw dbError('save agent memory', error);
  }
  if (removed.length) {
    const { error } = await db.from('agent_files').delete().in('path', removed);
    if (error) throw dbError('save agent memory', error);
  }
}

async function updateConversation(
  db: SupabaseClient,
  id: string,
  patch: Partial<Pick<ConversationRow, 'agent_history' | 'pending_action'>>
): Promise<ConversationRow> {
  const { data, error } = await db
    .from('conversations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(CONVERSATION_COLUMNS)
    .single();
  if (error) throw dbError('update the conversation', error);
  return data as ConversationRow;
}

function pendingSummary(pending: StoredPendingAction | null) {
  return pending ? { tool: pending.tool, summary: pending.summary, createdAt: pending.createdAt } : null;
}

export const handler = withHttp('chat', async (event) => {
  const caller = await requireAllowedCaller(event);
  enforceRateLimit(`chat:${caller.userId}`, { limit: 20, windowMs: 60_000 });

  const body = parseBody<ChatRequest>(event);
  const text = typeof body.message === 'string' ? body.message.trim() : '';
  if (!text) throw new HttpError(400, 'message is required');
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `message is too long (max ${MAX_MESSAGE_CHARS} characters)`);
  }
  const conversationId = body.conversationId ?? null;
  if (conversationId !== null && (typeof conversationId !== 'string' || !UUID_RE.test(conversationId))) {
    throw new HttpError(400, 'conversationId must be a UUID');
  }

  const db = supabaseForCaller(caller);
  const conversation = conversationId
    ? await loadConversation(db, conversationId)
    : await createConversation(db, caller, text);
  const userMessage = await insertMessage(db, caller, conversation.id, 'user', text);
  const files = await loadFiles(db);

  let updated: ConversationRow;
  let reply: MessageRow;
  try {
    const turn = await runAgentTurn({
      conversationId: conversation.id,
      user: {
        id: caller.userId,
        email: caller.email,
        displayName: caller.email?.split('@')[0] ?? 'there',
      },
      text,
      snapshot: {
        history: conversation.agent_history ?? [],
        pending: conversation.pending_action,
        files,
      },
    });
    await saveFiles(db, caller, turn.changedFiles, turn.removedPaths);
    updated = await updateConversation(db, conversation.id, {
      agent_history: turn.history,
      pending_action: turn.pending,
    });
    reply = await insertMessage(db, caller, conversation.id, 'assistant', turn.reply || '(No response)');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('[chat] agent turn failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    updated = await updateConversation(db, conversation.id, {});
    reply = await insertMessage(db, caller, conversation.id, 'error', `Error: ${message}`);
  }

  return json(200, {
    conversation: { id: updated.id, title: updated.title, updated_at: updated.updated_at },
    userMessage,
    reply,
    pending: pendingSummary(updated.pending_action),
  });
});
