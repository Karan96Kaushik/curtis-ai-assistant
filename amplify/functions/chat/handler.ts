import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, json, parseBody, withHttp } from '../_shared/http.js';
import { enforceRateLimit } from '../_shared/rateLimit.js';
import { supabaseForCaller } from '../_shared/supabaseUser.js';
import { requireAllowedCaller, type AuthedCaller } from '../_shared/verifySupabaseAuth.js';
import type { StoredPendingAction } from './agentRuntime.js';
import aiRouter from '../../../src/integrations/aiRouter.js';
import { isAgentModel, resolveAgentModel } from '../../../lib/chat/models.js';
import { isCancelError, watchCancellation } from './cancellation.js';
import {
  dbError,
  executeConversationPrompt,
  loadOwnedConversation,
  type ConversationRow,
} from './conversationTurn.js';
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

const MAX_MESSAGE_CHARS = 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONVERSATION_COLUMNS = 'id, title, agent_history, pending_action, created_at, updated_at';

function titleFromMessage(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
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
    ? await loadOwnedConversation(db, conversationId, caller.userId)
    : await createConversation(db, caller, text);

  const controller = new AbortController();
  const stopWatch = watchCancellation(db, conversation.id, turnId, controller);
  const turnCtx: TurnCtx = { model, signal: controller.signal, switches: [] };
  try {
    const result = await runWithTurn(turnCtx, () =>
      executeConversationPrompt({
        db,
        userId: caller.userId,
        user: {
          id: caller.userId,
          email: caller.email,
          displayName: caller.email?.split('@')[0] ?? 'there',
        },
        conversation,
        text,
        phoneNotifications: phoneContextForTurn(text, conversation.pending_action, body.phoneNotifications),
        signal: controller.signal,
        model,
        switches: turnCtx.switches,
      })
    );
    if (result.kind === 'cancelled') {
      return json(200, {
        cancelled: true,
        conversation: {
          id: result.conversation.id,
          title: result.conversation.title,
          updated_at: result.conversation.updated_at,
        },
        userMessage: result.userMessage,
        reply: null,
        pending: result.pending,
      });
    }
    return json(200, {
      conversation: { id: result.conversation.id, title: result.conversation.title, updated_at: result.conversation.updated_at },
      userMessage: result.userMessage,
      reply: result.reply,
      pending: result.pending,
    });
  } finally {
    stopWatch();
  }
});
