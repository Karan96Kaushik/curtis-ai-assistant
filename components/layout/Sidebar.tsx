import { Link, NavLink, useNavigate } from 'react-router';
import { CalendarClock, LogOut, Settings, SquarePen } from 'lucide-react';
import { toast } from 'sonner';
import ConversationList from '@/components/chat/ConversationList';
import { BrandMark } from '@/components/layout/BrandMark';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';

export default function Sidebar() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex h-full flex-col text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <BrandMark />
        <span className="text-base font-semibold tracking-tight">Curtis</span>
      </div>

      <div className="px-3 pb-2">
        <Button asChild variant="outline" className="w-full justify-start bg-background">
          <Link to="/">
            <SquarePen />
            New chat
          </Link>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ConversationList />
      </div>

      {user && (
        <div className="border-t border-sidebar-border p-2">
          <NavLink
            to="/schedules"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent',
                isActive && 'bg-sidebar-accent font-medium'
              )
            }
          >
            <CalendarClock className="size-4" />
            Schedules
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-sidebar-accent',
                isActive && 'bg-sidebar-accent font-medium'
              )
            }
          >
            <Settings className="size-4" />
            Settings
          </NavLink>
          <div className="mt-1 flex items-center gap-2 rounded-md px-3 py-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary uppercase">
              {(user.email ?? '?').slice(0, 1)}
            </div>
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={user.email ?? undefined}>
              {user.email}
            </span>
            <Button variant="ghost" size="icon-sm" onClick={handleSignOut} aria-label="Sign out" title="Sign out">
              <LogOut />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
