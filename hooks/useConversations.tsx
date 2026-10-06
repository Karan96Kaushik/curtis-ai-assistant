import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { upsertConversation } from '@/lib/chat/conversations';
import { deleteConversation, listConversations, renameConversation } from '@/lib/supabase/conversations';
import type { ConversationSummary } from '@/lib/supabase/types';

interface ConversationsContextValue {
  conversations: ConversationSummary[];
  loading: boolean;
  refresh(): Promise<void>;
  /** Insert or move a conversation to the top after a chat turn. */
  touch(conversation: ConversationSummary): void;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const ConversationsContext = createContext<ConversationsContextValue | null>(null);

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) {
      setConversations([]);
      return;
    }
    setLoading(true);
    try {
      setConversations(await listConversations());
    } catch (err) {
      toast.error(`Could not load chats: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const touch = useCallback((conversation: ConversationSummary) => {
    setConversations((items) => upsertConversation(items, conversation));
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    const trimmed = title.trim().slice(0, 200);
    if (!trimmed) return;
    await renameConversation(id, trimmed);
    setConversations((items) => items.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteConversation(id);
    setConversations((items) => items.filter((c) => c.id !== id));
  }, []);

  const value = useMemo(
    () => ({ conversations, loading, refresh, touch, rename, remove }),
    [conversations, loading, refresh, touch, rename, remove]
  );

  return <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>;
}

export function useConversations(): ConversationsContextValue {
  const ctx = useContext(ConversationsContext);
  if (!ctx) throw new Error('useConversations must be used inside <ConversationsProvider>');
  return ctx;
}
