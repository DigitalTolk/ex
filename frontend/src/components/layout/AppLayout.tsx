import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { Sidebar } from './Sidebar';
import { SearchBar } from '@/components/SearchBar';
import { TagSearchProvider } from '@/context/TagSearchContext';
import { Button } from '@/components/ui/button';
import { Menu } from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';

interface AppLayoutProps {
  children: ReactNode;
}

const CHANNEL_OPEN_MS = 180;
const CHANNEL_OPEN_MIN_SWIPE = 72;
const CHANNEL_OPEN_MAX_CROSS_AXIS = 48;

export function AppLayout({ children }: AppLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isMobile = useIsMobile();
  const [channelDragOffset, setChannelDragOffset] = useState(0);
  const [channelOpening, setChannelOpening] = useState(false);
  const channelOpenTimerRef = useRef<number | null>(null);

  const canOpenChannelsFromSwipe = useCallback((eventTarget: EventTarget | null) => {
    if (isHome) return false;
    if (eventTarget instanceof Element && eventTarget.closest('[data-mobile-right-sidebar="true"]')) return false;
    if (document.querySelector('[data-mobile-right-sidebar="true"]')) return false;
    return true;
  }, [isHome]);

  const openChannelsWithAnimation = useCallback(() => {
    if (isHome || channelOpenTimerRef.current !== null) return;
    setChannelDragOffset(0);
    setChannelOpening(true);
    channelOpenTimerRef.current = window.setTimeout(() => {
      channelOpenTimerRef.current = null;
      setChannelOpening(false);
      navigate('/');
    }, CHANNEL_OPEN_MS);
  }, [isHome, navigate]);

  useEffect(() => {
    return () => {
      if (channelOpenTimerRef.current !== null) window.clearTimeout(channelOpenTimerRef.current);
    };
  }, []);

  const openChannelsSwipe = useSwipeable({
    delta: 4,
    trackMouse: false,
    preventScrollOnSwipe: false,
    onSwiping: ({ absY, deltaX, event }) => {
      if (channelOpenTimerRef.current !== null) return;
      if (!canOpenChannelsFromSwipe(event.target)) {
        setChannelDragOffset(0);
        return;
      }
      if (deltaX <= 0 || absY > CHANNEL_OPEN_MAX_CROSS_AXIS) {
        setChannelDragOffset(0);
        return;
      }
      setChannelDragOffset(deltaX);
    },
    onSwipedRight: ({ absY, deltaX, event }) => {
      if (
        canOpenChannelsFromSwipe(event.target) &&
        deltaX >= CHANNEL_OPEN_MIN_SWIPE &&
        absY <= CHANNEL_OPEN_MAX_CROSS_AXIS
      ) {
        openChannelsWithAnimation();
      } else {
        setChannelDragOffset(0);
      }
    },
    onSwiped: () => {
      if (channelOpenTimerRef.current === null) setChannelDragOffset(0);
    },
  });
  const channelOpenActive = !isHome && (channelDragOffset > 0 || channelOpening);
  const mainDragStyle: CSSProperties | undefined = useMemo(() => {
    if (!channelOpenActive) return undefined;
    if (channelOpening) {
      return { transform: 'translateX(100vw)' };
    }
    return {
      transform: `translateX(${Math.round(channelDragOffset)}px)`,
      transition: 'none',
    };
  }, [channelDragOffset, channelOpenActive, channelOpening]);

  return (
    <TagSearchProvider>
      <div className="flex h-full flex-col overflow-hidden bg-[#1a1d21] pt-[env(safe-area-inset-top)]">
        {/* Slack/Mattermost-style thin top bar. On mobile, channels/DMs are
            the primary home view, so the left control navigates there
            instead of opening a temporary side-over. */}
        <header className="grid h-11 w-full shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 border-b bg-[#1a1d21] px-3 text-foreground lg:flex">
          <Button
            variant="ghost"
            size="icon"
            onClick={openChannelsWithAnimation}
            aria-label="Open channels"
            aria-hidden={isHome}
            tabIndex={isHome ? -1 : 0}
            className={`text-zinc-200 hover:bg-white/10 lg:hidden ${isHome ? 'invisible' : ''}`}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="min-w-0 w-full max-w-2xl justify-self-center lg:mx-auto lg:flex-1">
            <SearchBar />
          </div>
          <div className="h-11 w-11 lg:hidden" aria-hidden />
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden bg-background">
          <aside className="hidden w-72 shrink-0 bg-[#1a1d21] lg:block">
            <Sidebar onClose={() => undefined} />
          </aside>
          {isMobile && !isHome && (
            <aside
              className={`fixed inset-x-0 bottom-0 top-[calc(2.75rem+env(safe-area-inset-top))] z-0 bg-[#1a1d21] text-zinc-100 transition-opacity duration-150 lg:hidden ${channelOpenActive ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              aria-hidden="true"
              data-testid="mobile-channel-sidebar-preview"
            >
              <Sidebar onClose={() => undefined} />
            </aside>
          )}
          <main
            className={`flex min-h-0 flex-1 flex-col overflow-hidden bg-background max-md:relative max-md:z-10 max-md:touch-pan-y max-md:transform-gpu max-md:ease-out ${channelOpening ? 'max-md:transition-transform max-md:duration-200' : ''}`}
            style={mainDragStyle}
            data-channel-dragging={channelOpenActive ? 'true' : 'false'}
            {...openChannelsSwipe}
          >
            {children}
          </main>
        </div>
      </div>
    </TagSearchProvider>
  );
}
