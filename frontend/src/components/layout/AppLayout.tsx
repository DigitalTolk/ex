import { type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { SearchBar } from '@/components/SearchBar';
import { TagSearchProvider } from '@/context/TagSearchContext';
import { Button } from '@/components/ui/button';
import { Menu, ServerCog } from 'lucide-react';

interface AppLayoutProps {
  children: ReactNode;
}

interface NativeServerNavigation {
  resetServer?: () => Promise<void>;
}

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      Plugins?: {
        ServerNavigation?: NativeServerNavigation;
      };
    };
  }
}

export function AppLayout({ children }: AppLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isHome = location.pathname === '/';
  const nativePlugin = window.Capacitor?.Plugins?.ServerNavigation;
  const serverNavigation = window.Capacitor?.isNativePlatform?.() && nativePlugin?.resetServer
    ? nativePlugin
    : null;

  return (
    <TagSearchProvider>
      <div className="flex h-full flex-col overflow-hidden bg-[#1a1d21] pt-[env(safe-area-inset-top)]">
        {/* Slack/Mattermost-style thin top bar. On mobile, channels/DMs are
            the primary home view, so the left control navigates there
            instead of opening a temporary side-over. */}
        <header className="flex h-11 w-full shrink-0 items-center gap-2 border-b bg-[#1a1d21] px-3 text-foreground">
          {serverNavigation && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void serverNavigation.resetServer?.()}
              aria-label="Change server"
              className="text-zinc-200 hover:bg-white/10"
            >
              <ServerCog className="h-5 w-5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            aria-label="Open channels"
            aria-hidden={isHome}
            tabIndex={isHome ? -1 : 0}
            className={`text-zinc-200 hover:bg-white/10 lg:hidden ${isHome ? 'invisible' : ''}`}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1 lg:mx-auto lg:max-w-2xl">
            <SearchBar />
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden bg-background">
          <aside className="hidden w-72 shrink-0 bg-[#1a1d21] lg:block">
            <Sidebar onClose={() => undefined} />
          </aside>
          <main className="flex flex-1 flex-col overflow-hidden bg-background">{children}</main>
        </div>
      </div>
    </TagSearchProvider>
  );
}
