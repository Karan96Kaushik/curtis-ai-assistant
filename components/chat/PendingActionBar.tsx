import { Check, ShieldAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { pendingLabel, type PendingAction } from '@/lib/chat/pending';

export default function PendingActionBar({
  pending,
  disabled,
  onConfirm,
  onCancel,
}: {
  pending: PendingAction;
  disabled: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const sharingPhone = pending.tool === 'request_phone_notifications';
  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium">Waiting for your confirmation</span>
        <Badge variant="outline" className="ml-auto">
          {pendingLabel(pending.tool)}
        </Badge>
      </div>
      <pre className="mt-2 max-h-40 overflow-y-auto font-sans text-xs whitespace-pre-wrap text-muted-foreground">
        {pending.summary}
      </pre>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel} disabled={disabled}>
          <X />
          Cancel
        </Button>
        <Button size="sm" onClick={onConfirm} disabled={disabled}>
          <Check />
          {sharingPhone ? 'Share notifications' : 'Confirm'}
        </Button>
      </div>
    </div>
  );
}
