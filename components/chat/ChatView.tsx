import { useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import Composer from '@/components/chat/Composer';
import EmptyState from '@/components/chat/EmptyState';
import MessageBubble from '@/components/chat/MessageBubble';
import PendingActionBar from '@/components/chat/PendingActionBar';
import WorkingIndicator from '@/components/chat/WorkingIndicator';
import { Button } from '@/components/ui/button';
import { useChat } from '@/hooks/useChat';
import { useConversations } from '@/hooks/useConversations';
import { functionsConfigured } from '@/lib/amplify/client';

export default function ChatView() {
  const params = useParams();
  const conversationId = params.conversationId ?? null;
  const navigate = useNavigate();
  const { conversations } = useConversations();

  const onConversationCreated = useCallback(
    (id: string) => navigate(`/c/${id}`, { replace: true }),
    [navigate]
  );
  const { messages, pending, loading, sending, notFound, send } = useChat(conversationId, { onConversationCreated });

  const title = conversations.find((c) => c.id === conversationId)?.title;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, sending, pending]);

  useEffect(() => {
    document.title = title ? `${title} · Curtis` : 'Curtis';
  }, [title]);

  const isEmpty = !conversationId && messages.length === 0;
  const disabled = !functionsConfigured;

  return (
    <div className="flex h-full flex-col">
      {conversationId && (
        <div className="hidden h-14 shrink-0 items-center border-b px-6 md:flex">
          <h1 className="truncate text-sm font-medium">{title ?? 'Chat'}</h1>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isEmpty ? (
          <EmptyState disabled={disabled || sending} onPick={(prompt) => void send(prompt)} />
        ) : loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : notFound ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">This chat doesn’t exist or was deleted.</p>
            <Button asChild variant="outline" size="sm">
              <Link to="/">Start a new chat</Link>
            </Button>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 md:px-6">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {sending && <WorkingIndicator />}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pt-2 pb-4 md:px-6">
        {pending && !sending && (
          <PendingActionBar
            pending={pending}
            disabled={sending || disabled}
            onConfirm={() => void send('yes')}
            onCancel={() => void send('cancel')}
          />
        )}
        <Composer sending={sending} disabled={disabled} onSend={send} autoFocusKey={conversationId ?? 'new'} />
        <p className="text-center text-xs text-muted-foreground">
          Curtis can make mistakes. Jira and GitHub changes run only after you confirm.
        </p>
      </div>
    </div>
  );
}
