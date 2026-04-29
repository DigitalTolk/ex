import { useState, type ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { SearchBar } from '@/components/SearchBar';
import { TagSearchProvider } from '@/context/TagSearchContext';
import { Button } from '@/components/ui/button';
import { Menu, X } from 'lucide-react';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <TagSearchProvider>
      <div className="flex h-full flex-col overflow-hidden">
        {/* Slack/Mattermost-style thin top bar: full width, search
            centered, mobile-menu button on the left at small screens. */}
        <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-[#1a1d21] px-3 text-foreground">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label="Open sidebar"
            className="text-zinc-200 hover:bg-white/10 lg:hidden"
          >
            {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <div className="mx-auto w-full max-w-2xl">
            <SearchBar />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          {sidebarOpen && (
            <div
              className="fixed inset-0 z-20 bg-black/50 lg:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden="true"
            />
          )}
          <aside
            className={`
              fixed inset-y-0 left-0 top-11 z-30 w-72 transform bg-[#1a1d21] transition-transform duration-200 ease-in-out
              lg:static lg:top-0 lg:translate-x-0
              ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
            `}
          >
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </aside>
          <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </div>
    </TagSearchProvider>
  );
}
