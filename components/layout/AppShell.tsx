import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import { Menu, SquarePen } from 'lucide-react';
import ConfigBanner from '@/components/layout/ConfigBanner';
import { BrandMark } from '@/components/layout/BrandMark';
import Sidebar from '@/components/layout/Sidebar';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { functionsConfigured } from '@/lib/amplify/client';

export default function AppShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-72 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
        <Sidebar />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-2 md:hidden">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Open menu">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent className="bg-sidebar p-0">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <SheetDescription className="sr-only">Chats, agents, and settings</SheetDescription>
              <Sidebar />
            </SheetContent>
          </Sheet>
          <BrandMark className="size-6" />
          <span className="font-semibold">Curtis</span>
          <Button asChild variant="ghost" size="icon" className="ml-auto" aria-label="New chat">
            <Link to="/">
              <SquarePen />
            </Link>
          </Button>
        </header>

        {!functionsConfigured && <ConfigBanner />}

        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
