import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '../_shared/http.js';
import modelCatalog from '../../../src/integrations/modelCatalog.js';
import phoneNotifications from '../../../src/ai/phoneNotifications.js';
import { isCancelError } from './cancellation.js';
import {
  applyContexts,
  backfillOrgMemory,
  loadContexts,
  persistableFiles,
  syncContextsFromTurn,
} from './contextSync.js';
import {
  runAgentTurn,
  type AgentMessage,
  type AgentUser,
  type StateFile,
  type StoredPendingAction,
} from './agentRuntime.js';

const phone = phoneNotifications as unknown as { TOOL_NAME: string };

const catalog = modelCatalog as unknown as {
  switchNotice(switches: { from: string; to: string }[] | undefined): string | null;
};

export interface ConversationRow {
  id: string;
  title: string;
  agent_history: AgentMessage[] | null;
  pending_action: StoredPendingAction | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  created_at: string;
}

export interface PendingSummary {
  tool: string;
  summary: string;
  createdAt: number;
  durationMinutes?: number;
}

export type ExecuteResult =
  | {
      kind: 'ok' | 'error';
      userMessage: MessageRow;
      reply: MessageRow;
      conversation: ConversationRow;
      pending: PendingSummary | null;
    }
  | {
      kind: 'cancelled';
      userMessage: MessageRow;
      conversation: ConversationRow;
      pending: PendingSummary | null;
    };

const CONVERSATION_COLUMNS = 'id, title, agent_history, pending_action, created_at, updated_at';

export function dbError(action: string, error: { message: string }): HttpError {
  console.error(`[chat] ${action} failed:`, error.message);
  return new HttpError(502, `Could not ${action}`);
}

export function pendingSummary(pending: StoredPendingAction | null): PendingSummary | null {
  if (!pending) return null;
  const summary: PendingSummary = {
    tool: pending.tool,
    summary: pending.summary,
    createdAt: pending.createdAt,
  };
  if (pending.tool === phone.TOOL_NAME) {
    const minutes = pending.args?.duration_minutes;
    if (typeof minutes === 'number') summary.durationMinutes = minutes;
  }
  return summary;
}

export async function loadOwnedConversation(
  db: SupabaseClient,
  id: string,
  userId: string
): Promise<ConversationRow> {
  const { data, error } = await db
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw dbError('load the conversation', error);
  if (!data) throw new HttpError(404, 'Conversation not found');
  return data as ConversationRow;
}

async function insertMessage(
  db: SupabaseClient,
  userId: string,
  conversationId: string,
  role: MessageRow['role'],
  content: string
): Promise<MessageRow> {
  const { data, error } = await db
    .from('messages')
    .insert({ conversation_id: conversationId, user_id: userId, role, content })
    .select('id, conversation_id, role, content, created_at')
    .single();
  if (error) throw dbError('save the message', error);
  return data as MessageRow;
}

async function loadFiles(db: SupabaseClient, userId: string): Promise<StateFile[]> {
  const { data, error } = await db.from('agent_files').select('path, content').eq('user_id', userId);
  if (error) throw dbError('load agent memory', error);
  return (data ?? []) as StateFile[];
}

async function saveFiles(db: SupabaseClient, userId: string, changed: StateFile[], removed: string[]): Promise<void> {
  if (changed.length) {
    const updatedAt = new Date().toISOString();
    const { error } = await db
      .from('agent_files')
      .upsert(changed.map((f) => ({ user_id: userId, path: f.path, content: f.content, updated_at: updatedAt })));
    if (error) throw dbError('save agent memory', error);
  }
  if (removed.length) {
    const { error } = await db.from('agent_files').delete().eq('user_id', userId).in('path', removed);
    if (error) throw dbError('save agent memory', error);
  }
}

async function updateConversation(
  db: SupabaseClient,
  userId: string,
  id: string,
  patch: Partial<Pick<ConversationRow, 'agent_history' | 'pending_action'>>
): Promise<ConversationRow> {
  const { data, error } = await db
    .from('conversations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select(CONVERSATION_COLUMNS)
    .single();
  if (error) throw dbError('update the conversation', error);
  return data as ConversationRow;
}

/**
 * Insert the user message, run the agent, and persist the reply.
 * Caller wraps this in the model-router turn context.
 */
export async function executeConversationPrompt({
  db,
  userId,
  user,
  conversation,
  text,
  agentText,
  phoneNotifications: phoneContext = null,
  signal,
  model,
  switches,
}: {
  db: SupabaseClient;
  userId: string;
  user: AgentUser;
  conversation: ConversationRow;
  text: string;
  /** Model input when it should differ from the transcript line stored in messages. */
  agentText?: string;
  phoneNotifications?: unknown;
  signal?: AbortSignal;
  model: string;
  switches: { from: string; to: string }[];
}): Promise<ExecuteResult> {
  const userMessage = await insertMessage(db, userId, conversation.id, 'user', text);
  try {
    const loadedFiles = await loadFiles(db, userId);
    let contextsState;
    try {
      contextsState = await loadContexts(db, userId);
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'unknown error';
      throw dbError('load contexts', { message });
    }
    let contexts = contextsState.rows;
    if (contextsState.enabled) {
      try {
        contexts = await backfillOrgMemory(db, userId, loadedFiles, contexts);
      } catch (err) {
        console.error('[chat] org memory backfill failed:', err);
      }
    }
    const files = contextsState.enabled ? applyContexts(loadedFiles, contexts) : loadedFiles;

    const turn = await runAgentTurn({
      conversationId: conversation.id,
      user,
      text: agentText ?? text,
      snapshot: {
        history: conversation.agent_history ?? [],
        pending: conversation.pending_action,
        files,
      },
      phoneNotifications: phoneContext,
      scheduling: { db, model },
    });
    if (signal?.aborted) {
      const cancelled = new Error('Cancelled');
      cancelled.name = 'AbortError';
      throw cancelled;
    }

    const persisted = persistableFiles(turn.changedFiles, turn.removedPaths, loadedFiles);
    await saveFiles(db, userId, persisted.changed, persisted.removed);
    if (contextsState.enabled) {
      try {
        await syncContextsFromTurn(db, userId, contexts, turn.changedFiles, turn.removedPaths);
      } catch (err) {
        console.error('[chat] context sync failed:', err);
      }
    }
    const updated = await updateConversation(db, userId, conversation.id, {
      agent_history: turn.history,
      pending_action: turn.pending,
    });
    const reply = await insertMessage(db, userId, conversation.id, 'assistant', turn.reply || '(No response)');
    return { kind: 'ok', userMessage, reply, conversation: updated, pending: pendingSummary(updated.pending_action) };
  } catch (err) {
    if (isCancelError(err, signal)) {
      return {
        kind: 'cancelled',
        userMessage,
        conversation,
        pending: pendingSummary(conversation.pending_action),
      };
    }
    if (err instanceof HttpError) throw err;
    console.error('[chat] agent turn failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    const notice = catalog.switchNotice(switches);
    const detail = notice ? `${notice}\n\nError: ${message}` : `Error: ${message}`;
    const updated = await updateConversation(db, userId, conversation.id, {});
    const reply = await insertMessage(db, userId, conversation.id, 'error', detail);
    return {
      kind: 'error',
      userMessage,
      reply,
      conversation: updated,
      pending: pendingSummary(updated.pending_action),
    };
  }
}
