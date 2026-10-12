import { Bug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export default function ModelDebugToggle({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled?: boolean;
  onToggle(): void;
}) {
  return (
    <Button
      type="button"
      variant={enabled ? 'secondary' : 'outline'}
      size="sm"
      className={cn('gap-1.5', enabled && 'border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/15')}
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={enabled}
      title="When on, each reply includes the full messages and tools sent to the model"
    >
      <Bug className="size-3.5" />
      Model debugger
    </Button>
  );
}
