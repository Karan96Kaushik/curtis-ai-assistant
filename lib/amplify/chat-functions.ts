import { callFunction } from './client';
import type { ChatMessage, ConversationSummary } from '@/lib/supabase/types';
import type { PendingAction } from '@/lib/chat/pending';

export interface SendChatRequest {
  /** Omit to start a new conversation. */
  conversationId?: string | null;
  message: string;
}

export interface SendChatResponse {
  conversation: ConversationSummary;
  userMessage: ChatMessage;
  /** `role: 'error'` when the agent failed; the turn is still recorded. */
  reply: ChatMessage;
  pending: PendingAction | null;
}

export function sendChatMessage(request: SendChatRequest): Promise<SendChatResponse> {
  return callFunction<SendChatResponse>('chat', request);
}
