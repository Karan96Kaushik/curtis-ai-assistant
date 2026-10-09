import { memo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { BrandMark } from '@/components/layout/BrandMark';
import { Button } from '@/components/ui/button';
import type { DisplayMessage } from '@/hooks/useChat';
import { formatResponseDuration } from '@/lib/chat/duration';
import { splitModelSwitch } from '@/src/integrations/modelCatalog.js';
import { cn } from '@/lib/utils';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="size-7 text-muted-foreground"
      aria-label="Copy reply"
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

function ModelSwitch({ notice }: { notice: string | null }) {
  if (!notice) return null;
  return <p className="mt-1 text-xs text-muted-foreground">{notice}</p>;
}

function Duration({ ms }: { ms: number | null }) {
  if (ms == null) return null;
  return <p className="mt-1 text-xs text-muted-foreground">Took {formatResponseDuration(ms)}</p>;
}

function MessageBubble({ message, durationMs }: { message: DisplayMessage; durationMs: number | null }) {
  const { body, notice } = splitModelSwitch(message.content);
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground shadow-xs',
            message.local && 'opacity-70'
          )}
        >
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === 'error') {
    return (
      <div className="flex gap-3">
        <BrandMark className="mt-0.5 shrink-0" />
        <div className="min-w-0 max-w-[85%]">
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
          <Duration ms={durationMs} />
        </div>
      </div>
    );
  }

  return (
    <div className="group/msg flex gap-3">
      <BrandMark className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="chat-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
            }}
          >
            {body}
          </Markdown>
        </div>
        <ModelSwitch notice={notice} />
        <Duration ms={durationMs} />
        <div className="mt-1 opacity-0 transition-opacity group-hover/msg:opacity-100 max-md:opacity-100">
          <CopyButton text={body} />
        </div>
      </div>
    </div>
  );
}

export default memo(MessageBubble);
