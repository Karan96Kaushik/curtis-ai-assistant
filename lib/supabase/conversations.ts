import { supabase } from '@/utils/supabase';
import type { ConversationSummary } from './types';
import { parsePendingAction, type PendingAction } from '@/lib/chat/pending';

export async function listConversations(): Promise<ConversationSummary[]> {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data ?? [];
}

export async function getConversationPending(id: string): Promise<PendingAction | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('pending_action')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return parsePendingAction(data?.pending_action ?? null);
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const { error } = await supabase.from('conversations').update({ title }).eq('id', id);
  if (error) throw error;
}

export async function createConversation(title: string): Promise<ConversationSummary> {
  const { data, error } = await supabase.from('conversations').insert({ title }).select('id, title, updated_at').single();
  if (error) throw error;
  return data;
}

/** Ask the running chat function to abort this turn. Harmless if the turn already finished. */
export async function requestCancel(conversationId: string, turnId: string): Promise<void> {
  const { error } = await supabase.from('conversations').update({ cancel_turn_id: turnId }).eq('id', conversationId);
  if (error) throw error;
}

export async function deleteConversation(id: string): Promise<void> {
  const { error } = await supabase.from('conversations').delete().eq('id', id);
  if (error) throw error;
}
