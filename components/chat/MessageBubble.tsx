import { memo, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { BrandMark } from '@/components/layout/BrandMark';
import { Button } from '@/components/ui/button';
import type { DisplayMessage } from '@/hooks/useChat';
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

function MessageBubble({ message }: { message: DisplayMessage }) {
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
        <div className="flex max-w-[85%] items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p className="whitespace-pre-wrap">{message.content}</p>
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
            {message.content}
          </Markdown>
        </div>
        <div className="mt-1 opacity-0 transition-opacity group-hover/msg:opacity-100 max-md:opacity-100">
          <CopyButton text={message.content} />
        </div>
      </div>
    </div>
  );
}

export default memo(MessageBubble);
