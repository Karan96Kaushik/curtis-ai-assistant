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
  return callFunction<SendChatResponse>('chat', { action: 'send', ...request });
}

export interface BehaviorProposal {
  summary: string;
  content: string;
  previous: string;
}

/** Ask the model to draft behavior memory from a chat. Nothing is stored until the user approves. */
export function proposeBehaviorMemory(conversationId: string): Promise<BehaviorProposal> {
  return callFunction<BehaviorProposal>('chat', { action: 'propose-behavior', conversationId });
}
