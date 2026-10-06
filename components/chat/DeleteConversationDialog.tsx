import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ConversationSummary } from '@/lib/supabase/types';

export default function DeleteConversationDialog({
  conversation,
  onOpenChange,
  onConfirm,
}: {
  conversation: ConversationSummary | null;
  onOpenChange(open: boolean): void;
  onConfirm(): Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <Dialog open={!!conversation} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete chat?</DialogTitle>
          <DialogDescription>
            “{conversation?.title}” and its messages will be removed. Anything Curtis already did in Jira or GitHub stays
            as it is.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleting}
            onClick={async () => {
              setDeleting(true);
              await onConfirm();
              setDeleting(false);
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
