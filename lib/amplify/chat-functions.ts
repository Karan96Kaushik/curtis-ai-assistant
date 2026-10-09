import { callFunction } from './client';
import type { ChatMessage, ConversationSummary } from '@/lib/supabase/types';
import type { PendingAction } from '@/lib/chat/pending';
import type { PhoneNotificationContext } from '@/lib/supabase/notifications';

export interface SendChatRequest {
  /** Omit to start a new conversation. */
  conversationId?: string | null;
  message: string;
  /** Allow-listed Groq model id. */
  model?: string;
  /** Id the Stop button uses to cancel this turn. */
  turnId?: string;
  /** Present only when the user just confirmed a phone-notification request. */
  phoneNotifications?: PhoneNotificationContext;
}

export interface SendChatResponse {
  conversation: ConversationSummary;
  userMessage: ChatMessage;
  /** `role: 'error'` when the agent failed; the turn is still recorded. Null when cancelled. */
  reply: ChatMessage | null;
  pending: PendingAction | null;
  cancelled?: boolean;
}

export function sendChatMessage(request: SendChatRequest, signal?: AbortSignal): Promise<SendChatResponse> {
  return callFunction<SendChatResponse>('chat', { action: 'send', ...request }, { signal });
}

export interface BehaviorProposal {
  action: 'create' | 'update';
  slug: string;
  title: string;
  summary: string;
  content: string;
  previous: string;
}

/** Ask the model to draft behavior memory from a chat. Nothing is stored until the user approves. */
export function proposeBehaviorMemory(
  conversationId: string,
  options?: { signal?: AbortSignal; model?: string; turnId?: string }
): Promise<BehaviorProposal> {
  return callFunction<BehaviorProposal>(
    'chat',
    { action: 'propose-behavior', conversationId, model: options?.model, turnId: options?.turnId },
    { signal: options?.signal }
  );
}
