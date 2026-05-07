import { useCallback, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
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

const CHANNEL_OPEN_MIN_SWIPE = 72;
const CHANNEL_OPEN_MAX_CROSS_AXIS = 48;

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isMobile = useIsMobile();
  const [manualChannelsOpen, setManualChannelsOpen] = useState(false);
  const [channelDragOffset, setChannelDragOffset] = useState(0);
  const mobileChannelsOpen = isMobile && (isHome || manualChannelsOpen);

  const canOpenChannelsFromSwipe = useCallback((eventTarget: EventTarget | null) => {
    if (isHome) return false;
    if (eventTarget instanceof Element && eventTarget.closest('[data-mobile-right-sidebar="true"]')) return false;
    if (document.querySelector('[data-mobile-right-sidebar="true"]')) return false;
    return true;
  }, [isHome]);

  const openChannelsWithAnimation = useCallback(() => {
    setChannelDragOffset(0);
    setManualChannelsOpen(true);
  }, []);

  const closeChannels = useCallback(() => {
    setChannelDragOffset(0);
    setManualChannelsOpen(false);
  }, []);

  const openChannelsSwipe = useSwipeable({
    delta: 4,
    trackMouse: false,
    preventScrollOnSwipe: false,
    onSwiping: ({ absY, deltaX, event }) => {
      if (!isMobile || mobileChannelsOpen || !canOpenChannelsFromSwipe(event.target)) {
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
        isMobile &&
        !mobileChannelsOpen &&
        canOpenChannelsFromSwipe(event.target) &&
        deltaX >= CHANNEL_OPEN_MIN_SWIPE &&
        absY <= CHANNEL_OPEN_MAX_CROSS_AXIS
      ) {
        setManualChannelsOpen(true);
      }
      setChannelDragOffset(0);
    },
    onSwiped: () => {
      setChannelDragOffset(0);
    },
  });
  const mobileShellActive = isMobile && (mobileChannelsOpen || channelDragOffset > 0);
  const mainDragStyle: CSSProperties | undefined = useMemo(() => {
    if (!isMobile) return undefined;
    if (channelDragOffset > 0) {
      return { transform: `translate3d(${Math.round(channelDragOffset)}px, 0, 0)`, transition: 'none' };
    }
    return { transform: mobileChannelsOpen ? 'translate3d(100vw, 0, 0)' : 'translate3d(0, 0, 0)' };
  }, [channelDragOffset, isMobile, mobileChannelsOpen]);

  return (
    <TagSearchProvider>
      <div className="flex h-full flex-col overflow-hidden bg-[#1a1d21]">
        {/* Slack/Mattermost-style thin top bar. On mobile, channels/DMs live
            behind the persistent chat pane instead of in a temporary side-over. */}
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
          {isMobile && (
            <aside
              className="fixed inset-x-0 bottom-0 top-[calc(2.75rem+env(safe-area-inset-top))] z-0 bg-[#1a1d21] text-zinc-100 lg:hidden"
              aria-hidden={mobileChannelsOpen ? undefined : 'true'}
              inert={mobileChannelsOpen ? undefined : true}
              data-testid="mobile-channel-sidebar"
            >
              <Sidebar onClose={closeChannels} />
            </aside>
          )}
          <main
            className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background max-md:relative max-md:z-10 max-md:touch-pan-y max-md:transform-gpu max-md:transition-transform max-md:duration-200 max-md:ease-out"
            style={mainDragStyle}
            data-channel-dragging={mobileShellActive ? 'true' : 'false'}
            data-mobile-channels-open={mobileChannelsOpen ? 'true' : 'false'}
            {...openChannelsSwipe}
          >
            {children}
          </main>
        </div>
      </div>
    </TagSearchProvider>
  );
}
