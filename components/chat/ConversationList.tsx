import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import DeleteConversationDialog from '@/components/chat/DeleteConversationDialog';
import RenameConversationDialog from '@/components/chat/RenameConversationDialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useConversations } from '@/hooks/useConversations';
import { groupConversations } from '@/lib/chat/conversations';
import type { ConversationSummary } from '@/lib/supabase/types';
import { cn } from '@/lib/utils';

export default function ConversationList() {
  const { conversations, loading, rename, remove } = useConversations();
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const groups = useMemo(() => groupConversations(conversations), [conversations]);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null);

  async function handleRename(title: string) {
    if (!renaming) return;
    try {
      await rename(renaming.id, title);
      setRenaming(null);
    } catch (err) {
      toast.error(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await remove(deleting.id);
      if (deleting.id === conversationId) navigate('/', { replace: true });
      setDeleting(null);
    } catch (err) {
      toast.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (loading && !conversations.length) {
    return (
      <div className="space-y-2 px-2 pt-2">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (!conversations.length) {
    return <p className="px-3 pt-4 text-sm text-muted-foreground">No chats yet. Start one above.</p>;
  }

  return (
    <>
      <nav className="space-y-4 pt-2" aria-label="Chats">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
            <ul className="space-y-0.5">
              {group.items.map((c) => (
                <li key={c.id} className="group/item relative">
                  <NavLink
                    to={`/c/${c.id}`}
                    title={c.title}
                    className={({ isActive }) =>
                      cn(
                        'block truncate rounded-md py-2 pr-9 pl-3 text-sm transition-colors hover:bg-sidebar-accent',
                        isActive && 'bg-sidebar-accent font-medium'
                      )
                    }
                  >
                    {c.title}
                  </NavLink>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${c.title}`}
                        className="absolute top-1/2 right-1 size-7 -translate-y-1/2 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 max-md:opacity-100"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setRenaming(c)}>
                        <Pencil />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(c)}>
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <RenameConversationDialog
        conversation={renaming}
        onOpenChange={(open) => !open && setRenaming(null)}
        onSubmit={handleRename}
      />
      <DeleteConversationDialog
        conversation={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}
