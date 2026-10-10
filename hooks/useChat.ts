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
import { supabase } from '@/utils/supabase';

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

/** The new-chat route has no id yet. Real conversation ids are UUIDs. */
const NEW_CHAT_KEY = '';

function chatKey(conversationId: string | null): string {
  return conversationId ?? NEW_CHAT_KEY;
}

function mergeMessage(rows: DisplayMessage[], incoming: ChatMessage): DisplayMessage[] {
  if (rows.some((message) => message.id === incoming.id)) return rows;
  const withoutLocal = rows.filter(
    (message) => !(message.local && message.role === incoming.role && message.content === incoming.content)
  );
  return [...withoutLocal, incoming].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function mergeMessages(rows: DisplayMessage[], incoming: ChatMessage[]): DisplayMessage[] {
  return incoming.reduce(mergeMessage, rows);
}

export function useChat(conversationId: string | null, { onConversationCreated, modelRef }: UseChatOptions) {
  const { touch, noteActivity } = useConversations();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // The conversation that owns the in-flight turn. ChatView stays mounted across
  // /c/:id changes, so a bare boolean would show "working" on every chat.
  const inflightRef = useRef<string | null>(null);
  const [inflightId, setInflightId] = useState<string | null>(null);
  const sending = inflightId !== null && inflightId === chatKey(conversationId);

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

  useEffect(() => {
    if (!conversationId) return;
    const channel = supabase
      .channel(`messages-chat-${conversationId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
        (payload) => {
          const row = payload.new as ChatMessage;
          if (!row?.id || row.conversation_id !== conversationId) return;
          setMessages((messages) => mergeMessage(messages, row));
          setNotFound(false);
          if (row.created_at) noteActivity(conversationId, row.created_at);
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [conversationId, noteActivity]);

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
      if (!message) return false;
      if (inflightRef.current !== null) {
        if (inflightRef.current !== chatKey(conversationId)) {
          toast.error('Curtis is still working in another chat.');
        }
        return false;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const turnId = crypto.randomUUID();
      inflightRef.current = chatKey(conversationId);
      setInflightId(inflightRef.current);

      const optimistic: DisplayMessage = {
        id: `local-${Date.now()}`,
        conversation_id: conversationId ?? '',
        role: 'user',
        content: message,
        created_at: new Date().toISOString(),
        local: true,
      };

      let targetId = conversationId;
      try {
        setMessages((rows) => [...rows, optimistic]);

        if (!targetId) {
          const created = await createConversation(titleFromMessage(message));
          targetId = created.id;
          if (controller.signal.aborted) {
            await deleteConversation(targetId).catch(() => {});
            setMessages((rows) => rows.filter((m) => m.id !== optimistic.id));
            return false;
          }
          justCreated.current = targetId;
          inflightRef.current = targetId;
          setInflightId(targetId);
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
            setMessages((rows) => mergeMessages(rows.filter((m) => m.id !== optimistic.id), [res.userMessage]));
          }
          return true;
        }

        if (stillHere) {
          setMessages((rows) =>
            mergeMessages(
              rows.filter((m) => m.id !== optimistic.id),
              [res.userMessage, res.reply!]
            )
          );
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
        const stillOnTurn = targetId ? currentId.current === targetId : currentId.current === null;
        if (stillOnTurn) setMessages((rows) => rows.filter((m) => m.id !== optimistic.id));
        restoreComposerDraft(targetId, message);
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          turnRef.current = null;
          inflightRef.current = null;
          setInflightId(null);
        }
      }
    },
    [conversationId, touch, onConversationCreated, modelRef]
  );

  return { messages, pending, loading, sending, notFound, send, cancel };
}
