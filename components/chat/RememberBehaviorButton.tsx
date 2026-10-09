import { useRef, useState } from 'react';
import { Brain, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { proposeBehaviorMemory } from '@/lib/amplify/chat-functions';
import { MAX_BEHAVIOR_CHARS } from '@/lib/contexts/slugs';
import { contextsTableMissing, errorText, saveBehaviorContext } from '@/lib/supabase/contexts';
import { requestCancel } from '@/lib/supabase/conversations';

type Phase = 'loading' | 'review' | 'saving';

function explain(err: unknown): string {
  const message = errorText(err);
  if (/message is required/i.test(message)) {
    return 'Save behavior needs the updated chat function. Redeploy it with npm run amplify:sandbox, then try again.';
  }
  if (contextsTableMissing(err) || /contexts table/i.test(message)) {
    return 'Run supabase/migrations/0002_contexts.sql in the Supabase SQL editor, then try again.';
  }
  if (/contexts_one_behavior|duplicate key/i.test(message)) {
    return 'Run supabase/migrations/0004_multiple_behaviors.sql in the Supabase SQL editor, then try again.';
  }
  return message;
}

export default function RememberBehaviorButton({
  conversationId,
  model,
  disabled,
}: {
  conversationId: string;
  model: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [summary, setSummary] = useState('');
  const [action, setAction] = useState<'create' | 'update'>('create');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [previous, setPrevious] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const turnRef = useRef<{ conversationId: string; turnId: string } | null>(null);

  function stopReading() {
    abortRef.current?.abort();
    const turn = turnRef.current;
    if (!turn) return;
    void requestCancel(turn.conversationId, turn.turnId).catch(() => {});
  }

  async function start() {
    const id = ++requestId.current;
    const controller = new AbortController();
    abortRef.current = controller;
    const turnId = crypto.randomUUID();
    turnRef.current = { conversationId, turnId };
    setOpen(true);
    setPhase('loading');
    setError(null);
    setSummary('');
    setAction('create');
    setSlug('');
    setTitle('');
    setContent('');
    setPrevious('');
    try {
      const proposal = await proposeBehaviorMemory(conversationId, { signal: controller.signal, model, turnId });
      if (controller.signal.aborted || requestId.current !== id) return;
      setSummary(proposal.summary);
      setAction(proposal.action === 'update' ? 'update' : 'create');
      setSlug(proposal.slug);
      setTitle(proposal.title);
      setPrevious(proposal.previous ?? '');
      setContent(proposal.content ?? '');
      setPhase('review');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError') || requestId.current !== id) {
        return;
      }
      setError(explain(err));
      setPhase('review');
    }
  }

  async function approve() {
    setPhase('saving');
    try {
      const clearing = !content.trim();
      await saveBehaviorContext({ slug, title, content });
      toast.success(
        clearing
          ? `Removed “${title}”. Future chats will not use it.`
          : action === 'create'
            ? `Saved “${title}”. Future chats will follow it.`
            : `Updated “${title}”. Future chats will follow it.`
      );
      setOpen(false);
    } catch (err) {
      toast.error(explain(err));
      setPhase('review');
    }
  }

  const unchanged = content.trim() === previous.trim();
  const clearing = !content.trim() && previous.trim().length > 0;
  const titleOk = title.trim().length > 0 && title.trim().length <= 120;
  const canApprove = phase === 'review' && !error && !unchanged && titleOk && slug.length > 0 && content.length <= MAX_BEHAVIOR_CHARS;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => void start()}
        title="Read this chat and propose behavior memory"
      >
        <Brain />
        Save behavior
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && phase === 'loading') stopReading();
          setOpen(next);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Save behavior from this chat</DialogTitle>
            <DialogDescription>
              Curtis reads this chat and either folds the rule into an existing behavior title or starts a new one.
              Nothing is stored until you approve.
            </DialogDescription>
          </DialogHeader>

          {phase === 'loading' ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Reading this chat…
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : (
            <div className="grid gap-3">
              {summary && <p className="text-sm text-muted-foreground">{summary}</p>}
              <p className="text-sm">
                {action === 'create' ? 'New behavior context' : 'Folds into an existing behavior context'}
              </p>
              <div className="grid gap-2">
                <Label htmlFor="behavior-title">Title</Label>
                <Input
                  id="behavior-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  disabled={phase === 'saving'}
                />
              </div>
              <Textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                className="max-h-80 min-h-48 overflow-y-auto font-mono text-xs"
                aria-label="Proposed behavior memory"
                disabled={phase === 'saving'}
              />
              <p className="text-xs text-muted-foreground">
                {content.length.toLocaleString()} / {MAX_BEHAVIOR_CHARS.toLocaleString()} characters
                {content.length > MAX_BEHAVIOR_CHARS ? ' · Too long to save.' : ''}
                {unchanged ? ' · No changes from what is already saved.' : ''}
                {clearing ? ' · Approving this clears saved behavior.' : ''}
              </p>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (phase === 'loading') stopReading();
                setOpen(false);
              }}
              disabled={phase === 'saving'}
            >
              {phase === 'loading' ? 'Stop' : error ? 'Close' : 'Discard'}
            </Button>
            {!error && phase !== 'loading' && (
              <Button type="button" onClick={() => void approve()} disabled={!canApprove}>
                {phase === 'saving' && <Loader2 className="animate-spin" />}
                {clearing ? 'Clear behavior' : 'Approve'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
