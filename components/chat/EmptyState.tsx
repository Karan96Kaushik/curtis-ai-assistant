import { BrandMark } from '@/components/layout/BrandMark';
import { STARTER_PROMPTS } from '@/lib/chat/conversations';

export default function EmptyState({ disabled, onPick }: { disabled: boolean; onPick(prompt: string): void }) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-8 px-4 py-10 text-center">
      <div className="flex flex-col items-center gap-3">
        <BrandMark className="size-12 rounded-2xl" />
        <h1 className="text-2xl font-semibold tracking-tight">How can I help?</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          I can look up and update Jira tickets, dig into GitHub repos and PRs, run release workflows, and search the
          web. Changes always wait for your confirmation.
        </p>
      </div>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        {STARTER_PROMPTS.map((s) => (
          <button
            key={s.title}
            type="button"
            disabled={disabled}
            onClick={() => onPick(s.prompt)}
            className="rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="block text-sm font-medium">{s.title}</span>
            <span className="block truncate text-xs text-muted-foreground">{s.prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
