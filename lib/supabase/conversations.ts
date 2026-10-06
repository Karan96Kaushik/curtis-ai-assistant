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

export async function deleteConversation(id: string): Promise<void> {
  const { error } = await supabase.from('conversations').delete().eq('id', id);
  if (error) throw error;
}
