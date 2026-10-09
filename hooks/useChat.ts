import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { useConversations } from '@/hooks/useConversations';
import { sendChatMessage } from '@/lib/amplify/chat-functions';
import { restoreComposerDraft } from '@/lib/chat/composerDraft';
import type { PendingAction } from '@/lib/chat/pending';
import { parsePendingAction } from '@/lib/chat/pending';
import { createConversation, deleteConversation, getConversationPending, requestCancel } from '@/lib/supabase/conversations';
import { listMessages } from '@/lib/supabase/messages';
import type { ChatMessage } from '@/lib/supabase/types';

export interface DisplayMessage extends ChatMessage {
  /** Optimistic row not yet confirmed by the server. */
  local?: boolean;
}

interface UseChatOptions {
  /** Called when the first message of a new chat created a conversation. */
  onConversationCreated(id: string): void;
  /** Current Groq model id. A ref so Send does not wait on a re-render. */
  modelRef: RefObject<string>;
}

function titleFromMessage(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New chat';
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function useChat(conversationId: string | null, { onConversationCreated, modelRef }: UseChatOptions) {
  const { touch } = useConversations();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const currentId = useRef(conversationId);
  const justCreated = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnRef = useRef<{ conversationId: string; turnId: string } | null>(null);

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

  const cancel = useCallback(() => {
    const turn = turnRef.current;
    abortRef.current?.abort();
    if (!turn) return;
    void requestCancel(turn.conversationId, turn.turnId).catch(() => {
      // Stop still ends the wait. The server keeps going until the cancel column exists.
    });
  }, []);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const message = text.trim();
      if (!message || sending) return false;

      const controller = new AbortController();
      abortRef.current = controller;
      const turnId = crypto.randomUUID();
      const optimistic: DisplayMessage = {
        id: `local-${Date.now()}`,
        conversation_id: conversationId ?? '',
        role: 'user',
        content: message,
        created_at: new Date().toISOString(),
        local: true,
      };
      setMessages((rows) => [...rows, optimistic]);
      setSending(true);

      let targetId = conversationId;
      try {
        if (!targetId) {
          const created = await createConversation(titleFromMessage(message));
          targetId = created.id;
          if (controller.signal.aborted) {
            await deleteConversation(targetId).catch(() => {});
            setMessages((rows) => rows.filter((m) => m.id !== optimistic.id));
            return false;
          }
          justCreated.current = targetId;
          touch(created);
          onConversationCreated(targetId);
        }

        turnRef.current = { conversationId: targetId, turnId };
        const res = await sendChatMessage(
          { conversationId: targetId, message, model: modelRef.current, turnId },
          controller.signal
        );
        if (controller.signal.aborted) return true;
        touch(res.conversation);

        const stillHere = currentId.current === targetId;
        if (res.cancelled || !res.reply) {
          if (stillHere) {
            setMessages((rows) => [...rows.filter((m) => m.id !== optimistic.id), res.userMessage]);
          }
          return true;
        }

        if (stillHere) {
          setMessages((rows) => [...rows.filter((m) => m.id !== optimistic.id), res.userMessage, res.reply!]);
          setPending(parsePendingAction(res.pending));
        }
        if (res.reply.role === 'error') {
          restoreComposerDraft(targetId, message);
          return false;
        }
        return true;
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) {
          if (targetId && currentId.current === targetId) {
            const rows = await listMessages(targetId).catch(() => null);
            if (rows && currentId.current === targetId && rows.some((row) => row.role === 'user' && row.content === message)) {
              setMessages(rows);
            }
          }
          return true;
        }
        setMessages((rows) => rows.filter((m) => m.id !== optimistic.id));
        restoreComposerDraft(targetId, message);
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          turnRef.current = null;
          setSending(false);
        }
      }
    },
    [conversationId, sending, touch, onConversationCreated, modelRef]
  );

  return { messages, pending, loading, sending, notFound, send, cancel };
}
