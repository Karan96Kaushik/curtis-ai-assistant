import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

const MAX_CHARS = 4000;

export default function Composer({
  sending,
  disabled,
  onSend,
  autoFocusKey,
}: {
  sending: boolean;
  disabled?: boolean;
  onSend(text: string): Promise<boolean>;
  /** Refocus when this changes (e.g. switching chats). */
  autoFocusKey?: string;
}) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [autoFocusKey]);

  const canSend = !sending && !disabled && value.trim().length > 0 && value.length <= MAX_CHARS;

  async function submit() {
    if (!canSend) return;
    const text = value;
    setValue('');
    const ok = await onSend(text);
    if (!ok) setValue(text);
    ref.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form
      className="relative rounded-2xl border bg-card shadow-sm focus-within:ring-[3px] focus-within:ring-ring/30"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={disabled ? 'Chat backend not deployed' : 'Ask Curtis about Jira, GitHub, releases…'}
        disabled={disabled}
        rows={1}
        aria-label="Message"
        className="max-h-48 min-h-12 resize-none border-0 bg-transparent py-3.5 pr-14 pl-4 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="absolute right-2 bottom-2 flex items-center gap-2">
        {value.length > MAX_CHARS * 0.9 && (
          <span className={value.length > MAX_CHARS ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {value.length}/{MAX_CHARS}
          </span>
        )}
        <Button type="submit" size="icon-sm" className="rounded-full" disabled={!canSend} aria-label="Send">
          {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </form>
  );
}
