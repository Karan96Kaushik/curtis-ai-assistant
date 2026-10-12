import { useMemo, useState } from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ModelDebugCall } from '@/lib/chat/modelDebug';
import { cn } from '@/lib/utils';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-7 text-muted-foreground"
      aria-label="Copy model context"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export default function ModelContextDebugger({ calls }: { calls: ModelDebugCall[] }) {
  const [open, setOpen] = useState(true);
  const json = useMemo(() => JSON.stringify(calls, null, 2), [calls]);

  if (!calls.length) return null;

  return (
    <div className="rounded-xl border border-dashed border-amber-500/40 bg-amber-500/5">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <ChevronDown className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} />
        <span>
          Model context debugger — {calls.length} provider call{calls.length === 1 ? '' : 's'}
        </span>
        <span className="ml-auto text-xs font-normal text-muted-foreground">Not saved to chat history</span>
      </button>
      {open && (
        <div className="border-t border-dashed border-amber-500/30 px-2 pb-2">
          <div className="flex justify-end pt-1">
            <CopyButton text={json} />
          </div>
          <pre className="max-h-[min(70vh,32rem)] overflow-auto rounded-lg bg-background/80 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
            {json}
          </pre>
        </div>
      )}
    </div>
  );
}
