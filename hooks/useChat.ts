import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useConversations } from '@/hooks/useConversations';
import { sendChatMessage } from '@/lib/amplify/chat-functions';
import type { PendingAction } from '@/lib/chat/pending';
import { parsePendingAction } from '@/lib/chat/pending';
import { getConversationPending } from '@/lib/supabase/conversations';
import { listMessages } from '@/lib/supabase/messages';
import type { ChatMessage } from '@/lib/supabase/types';

export interface DisplayMessage extends ChatMessage {
  /** Optimistic row not yet confirmed by the server. */
  local?: boolean;
}

interface UseChatOptions {
  /** Called when the first message of a new chat created a conversation. */
  onConversationCreated(id: string): void;
}

export function useChat(conversationId: string | null, { onConversationCreated }: UseChatOptions) {
  const { touch } = useConversations();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const currentId = useRef(conversationId);
  const justCreated = useRef<string | null>(null);

  useEffect(() => {
    currentId.current = conversationId;
    setNotFound(false);

    if (!conversationId) {
      setMessages([]);
      setPending(null);
      return;
    }
    if (justCreated.current === conversationId) {
      justCreated.current = null;
      return;
    }

    let active = true;
    setLoading(true);
    setMessages([]);
    setPending(null);
    Promise.all([listMessages(conversationId), getConversationPending(conversationId)])
      .then(([rows, pendingAction]) => {
        if (!active) return;
        setMessages(rows);
        setPending(pendingAction);
        if (!rows.length && !pendingAction) setNotFound(true);
      })
      .catch((err) => {
        if (active) toast.error(`Could not load messages: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [conversationId]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const message = text.trim();
      if (!message || sending) return false;

      const targetId = conversationId;
      const optimistic: DisplayMessage = {
        id: `local-${Date.now()}`,
        conversation_id: targetId ?? '',
        role: 'user',
        content: message,
        created_at: new Date().toISOString(),
        local: true,
      };
      setMessages((rows) => [...rows, optimistic]);
      setSending(true);

      try {
        const res = await sendChatMessage({ conversationId: targetId, message });
        touch(res.conversation);

        const stillHere = currentId.current === targetId;
        if (!stillHere) return true;

        setMessages((rows) => [...rows.filter((m) => m.id !== optimistic.id), res.userMessage, res.reply]);
        setPending(parsePendingAction(res.pending));
        if (!targetId) {
          justCreated.current = res.conversation.id;
          onConversationCreated(res.conversation.id);
        }
        return true;
      } catch (err) {
        setMessages((rows) => rows.filter((m) => m.id !== optimistic.id));
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setSending(false);
      }
    },
    [conversationId, sending, touch, onConversationCreated]
  );

  return { messages, pending, loading, sending, notFound, send };
}
