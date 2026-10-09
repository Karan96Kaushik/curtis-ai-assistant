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
import aiRouter from '../../../src/integrations/aiRouter.js';
import modelCatalog from '../../../src/integrations/modelCatalog.js';
import { isAgentModel, resolveAgentModel } from '../../../lib/chat/models.js';
import { isCancelError, watchCancellation } from './cancellation.js';
import { applyContexts, backfillOrgMemory, loadContexts, persistableFiles, syncContextsFromTurn } from './contextSync.js';
import { proposeBehavior } from './proposeBehavior.js';
import phoneNotifications from '../../../src/ai/phoneNotifications.js';

interface TurnCtx {
  model: string;
  signal: AbortSignal;
  switches: { from: string; to: string }[];
  failedModels?: string[];
}

const { runWithTurn } = aiRouter as unknown as {
  runWithTurn<T>(ctx: TurnCtx, fn: () => Promise<T>): Promise<T>;
};

const phone = phoneNotifications as unknown as {
  TOOL_NAME: string;
  isConfirmation(text: string): boolean;
  parseClientPayload(raw: unknown): { context: { durationMinutes: number } | null; error: string | null };
};

const catalog = modelCatalog as unknown as {
  switchNotice(switches: { from: string; to: string }[] | undefined): string | null;
};

interface ChatRequest {
  action?: 'send' | 'propose-behavior';
  conversationId?: string | null;
  message?: string;
  /** Allow-listed Groq, Google AI Studio, or OpenRouter model id. Omitted requests use the server default. */
  model?: string;
  /** Client id for this turn, so Stop can mark it cancelled. */
  turnId?: string;
  /**
   * Phone notifications the browser read after the user confirmed a request.
   * Ignored unless this message confirms a pending request_phone_notifications action.
   */
  phoneNotifications?: unknown;
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
  if (!pending) return null;
  const summary: { tool: string; summary: string; createdAt: number; durationMinutes?: number } = {
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

/** Attach a notification window only when this message confirms a staged phone read. */
function phoneContextForTurn(text: string, pending: StoredPendingAction | null, raw: unknown): unknown {
  const parsed = phone.parseClientPayload(raw);
  if (parsed.error) throw new HttpError(400, parsed.error);
  if (!parsed.context) return null;
  if (!pending || pending.tool !== phone.TOOL_NAME || !phone.isConfirmation(text)) return null;
  return parsed.context;
}

function requestedModel(body: ChatRequest): string {
  if (body.model != null && typeof body.model !== 'string') throw new HttpError(400, 'model must be a string');
  if (typeof body.model === 'string' && body.model && !isAgentModel(body.model)) {
    throw new HttpError(400, 'That model is not available');
  }
  return resolveAgentModel(body.model, process.env.GROQ_MODEL);
}

function requestedTurnId(body: ChatRequest): string | null {
  if (body.turnId == null || body.turnId === '') return null;
  if (typeof body.turnId !== 'string' || !UUID_RE.test(body.turnId)) throw new HttpError(400, 'turnId must be a UUID');
  return body.turnId;
}

export const handler = withHttp('chat', async (event) => {
  const caller = await requireAllowedCaller(event);
  enforceRateLimit(`chat:${caller.userId}`, { limit: 20, windowMs: 60_000 });

  const body = parseBody<ChatRequest>(event);
  const db = supabaseForCaller(caller);

  if (body.action === 'propose-behavior') {
    const behaviorConversationId = body.conversationId;
    if (typeof behaviorConversationId !== 'string') throw new HttpError(400, 'conversationId must be a UUID');
    const model = requestedModel(body);
    const turnId = requestedTurnId(body);
    const controller = new AbortController();
    const stopWatch = watchCancellation(db, behaviorConversationId, turnId, controller);
    const behaviorTurn: TurnCtx = { model, signal: controller.signal, switches: [] };
    try {
      return await runWithTurn(behaviorTurn, () => proposeBehavior(db, behaviorConversationId));
    } catch (err) {
      if (isCancelError(err, controller.signal)) throw new HttpError(499, 'Cancelled');
      throw err;
    } finally {
      stopWatch();
    }
  }
  if (body.action != null && body.action !== 'send') throw new HttpError(400, 'Unknown action');

  const text = typeof body.message === 'string' ? body.message.trim() : '';
  if (!text) throw new HttpError(400, 'message is required');
  if (text.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, `message is too long (max ${MAX_MESSAGE_CHARS} characters)`);
  }
  const conversationId = body.conversationId ?? null;
  if (conversationId !== null && (typeof conversationId !== 'string' || !UUID_RE.test(conversationId))) {
    throw new HttpError(400, 'conversationId must be a UUID');
  }
  const model = requestedModel(body);
  const turnId = requestedTurnId(body);

  const conversation = conversationId
    ? await loadConversation(db, conversationId)
    : await createConversation(db, caller, text);
  const userMessage = await insertMessage(db, caller, conversation.id, 'user', text);
  const loadedFiles = await loadFiles(db);
  let contextsState;
  try {
    contextsState = await loadContexts(db);
  } catch (err) {
    const message = err && typeof err === 'object' && 'message' in err ? String(err.message) : 'unknown error';
    throw dbError('load contexts', { message });
  }
  let contexts = contextsState.rows;
  if (contextsState.enabled) {
    try {
      contexts = await backfillOrgMemory(db, caller.userId, loadedFiles, contexts);
    } catch (err) {
      console.error('[chat] org memory backfill failed:', err);
    }
  }
  const files = contextsState.enabled ? applyContexts(loadedFiles, contexts) : loadedFiles;

  let updated: ConversationRow;
  let reply: MessageRow | null;
  const controller = new AbortController();
  const stopWatch = watchCancellation(db, conversation.id, turnId, controller);
  const turnCtx: TurnCtx = { model, signal: controller.signal, switches: [] };
  try {
    const turn = await runWithTurn(turnCtx, () =>
      runAgentTurn({
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
        phoneNotifications: phoneContextForTurn(text, conversation.pending_action, body.phoneNotifications),
      })
    );
    if (controller.signal.aborted) {
      const cancelled = new Error('Cancelled');
      cancelled.name = 'AbortError';
      throw cancelled;
    }
    const persisted = persistableFiles(turn.changedFiles, turn.removedPaths, loadedFiles);
    await saveFiles(db, caller, persisted.changed, persisted.removed);
    if (contextsState.enabled) {
      try {
        await syncContextsFromTurn(db, caller.userId, contexts, turn.changedFiles, turn.removedPaths);
      } catch (err) {
        console.error('[chat] context sync failed:', err);
      }
    }
    updated = await updateConversation(db, conversation.id, {
      agent_history: turn.history,
      pending_action: turn.pending,
    });
    reply = await insertMessage(db, caller, conversation.id, 'assistant', turn.reply || '(No response)');
  } catch (err) {
    if (isCancelError(err, controller.signal)) {
      return json(200, {
        cancelled: true,
        conversation: { id: conversation.id, title: conversation.title, updated_at: conversation.updated_at },
        userMessage,
        reply: null,
        pending: pendingSummary(conversation.pending_action),
      });
    }
    if (err instanceof HttpError) throw err;
    console.error('[chat] agent turn failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    const notice = catalog.switchNotice(turnCtx.switches);
    const detail = notice ? `${notice}\n\nError: ${message}` : `Error: ${message}`;
    updated = await updateConversation(db, conversation.id, {});
    reply = await insertMessage(db, caller, conversation.id, 'error', detail);
  } finally {
    stopWatch();
  }

  return json(200, {
    conversation: { id: updated.id, title: updated.title, updated_at: updated.updated_at },
    userMessage,
    reply,
    pending: pendingSummary(updated.pending_action),
  });
});
