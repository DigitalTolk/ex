import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type WheelEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { Sidebar } from './Sidebar';
import { SearchBar } from '@/components/SearchBar';
import { TagSearchProvider } from '@/context/TagSearchContext';
import { Button } from '@/components/ui/button';
import { Menu } from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { UpdateBanner } from '@/components/UpdateBanner';
import { NotificationPermissionBanner } from '@/components/NotificationPermissionBanner';

interface AppLayoutProps {
  children: ReactNode;
}

const CHANNEL_OPEN_MIN_SWIPE = 72;
const CHANNEL_OPEN_MAX_CROSS_AXIS = 48;
const CHANNEL_OPEN_EDGE_PX = 32;

function blurActiveInput() {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]')
  ) {
    active.blur();
  }
}

export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isMobile = useIsMobile();
  const [manualChannelsOpen, setManualChannelsOpen] = useState(false);
  const [channelDragOffset, setChannelDragOffset] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const appHeaderRef = useRef<HTMLElement>(null);
  const mobileChannelsOpen = isMobile && (isHome || manualChannelsOpen);

  const canOpenChannelsFromSwipe = useCallback((eventTarget: EventTarget | null) => {
    if (isHome) return false;
    if (eventTarget instanceof Element && eventTarget.closest('[data-mobile-right-sidebar="true"]')) return false;
    if (document.querySelector('[data-mobile-right-sidebar="true"]')) return false;
    return true;
  }, [isHome]);

  const isChannelOpenEdgeSwipe = useCallback((initialX: number) => initialX <= CHANNEL_OPEN_EDGE_PX, []);

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
    preventScrollOnSwipe: true,
    onSwiping: ({ absY, deltaX, event, initial }) => {
      if (
        !isMobile ||
        mobileChannelsOpen ||
        !canOpenChannelsFromSwipe(event.target) ||
        !isChannelOpenEdgeSwipe(initial[0])
      ) {
        setChannelDragOffset(0);
        return;
      }
      if (deltaX <= 0 || absY > CHANNEL_OPEN_MAX_CROSS_AXIS) {
        setChannelDragOffset(0);
        return;
      }
      blurActiveInput();
      setChannelDragOffset(deltaX);
    },
    onSwipedRight: ({ absY, deltaX, event, initial }) => {
      if (
        isMobile &&
        !mobileChannelsOpen &&
        canOpenChannelsFromSwipe(event.target) &&
        isChannelOpenEdgeSwipe(initial[0]) &&
        deltaX >= CHANNEL_OPEN_MIN_SWIPE &&
        absY <= CHANNEL_OPEN_MAX_CROSS_AXIS
      ) {
        blurActiveInput();
        setManualChannelsOpen(true);
      }
      setChannelDragOffset(0);
    },
    onSwiped: () => {
      setChannelDragOffset(0);
    },
  });
  const { ref: openChannelsSwipeRef, ...openChannelsSwipeHandlers } = openChannelsSwipe;
  const setMainNode = useCallback((node: HTMLElement | null) => {
    mainRef.current = node;
    openChannelsSwipeRef(node);
  }, [openChannelsSwipeRef]);
  const mobileShellActive = isMobile && (mobileChannelsOpen || channelDragOffset > 0);
  /* v8 ignore start -- synthetic wheel support differs between jsdom and browsers; browser tests cover visibility around this surface. */
  const forwardHeaderWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    if (isMobile || event.defaultPrevented) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
    ) {
      return;
    }
    const root = mainRef.current ?? document;
    const scroller = root.querySelector<HTMLElement>('[data-page-scroll="true"], [data-testid="page-container"]');
    if (!scroller) return;
    const canScroll = scroller.scrollHeight > scroller.clientHeight;
    if (!canScroll) return;
    scroller.scrollTop += event.deltaY;
    event.preventDefault();
  }, [isMobile]);
  /* v8 ignore stop */
  /* v8 ignore start -- real wheel propagation is covered by browser interaction tests/manual browser behavior, not jsdom. */
  useEffect(() => {
    const node = appHeaderRef.current;
    if (!node) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof Node && !node.contains(target)) return;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')
      ) {
        return;
      }
      const root = mainRef.current ?? document;
      const scroller = root.querySelector<HTMLElement>('[data-page-scroll="true"], [data-testid="page-container"]');
      if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
      scroller.scrollTop += event.deltaY;
      event.preventDefault();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      node.removeEventListener('wheel', onWheel);
      document.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, []);
  /* v8 ignore stop */
  const mainDragStyle: CSSProperties | undefined = useMemo(() => {
    if (!isMobile) return undefined;
    if (channelDragOffset > 0) {
      return { transform: `translate3d(${Math.round(channelDragOffset)}px, 0, 0)`, transition: 'none' };
    }
    return { transform: mobileChannelsOpen ? 'translate3d(100vw, 0, 0)' : 'translate3d(0, 0, 0)' };
  }, [channelDragOffset, isMobile, mobileChannelsOpen]);

  return (
    <TagSearchProvider>
      <div className="flex h-full flex-col overflow-hidden bg-sidebar dark:bg-[#1a1d21]">
        {/* Slack/Mattermost-style thin top bar. On mobile, channels/DMs live
            behind the persistent chat pane instead of in a temporary side-over. */}
        <header
          ref={appHeaderRef}
          className="grid h-11 w-full shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 text-sidebar-foreground dark:border-white/10 dark:bg-[#1a1d21] dark:text-foreground lg:flex"
          onWheel={forwardHeaderWheel}
          data-testid="app-shell-header"
          data-app-chrome="true"
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={openChannelsWithAnimation}
            aria-label="Open channels"
            aria-hidden={isHome}
            tabIndex={isHome ? -1 : 0}
            className={`text-sidebar-foreground hover:bg-sidebar-accent dark:text-zinc-200 dark:hover:bg-white/10 lg:hidden ${isHome ? 'invisible' : ''}`}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="min-w-0 w-full max-w-2xl justify-self-center lg:mx-auto lg:flex-1">
            <SearchBar />
          </div>
          <div className="h-11 w-11 lg:hidden" aria-hidden />
        </header>
        <div
          className="relative z-20 shrink-0 bg-sidebar dark:bg-[#1a1d21]"
          data-testid="app-layout-banners"
          data-app-chrome="true"
        >
          <UpdateBanner />
          <NotificationPermissionBanner />
        </div>

        <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
          <aside
            className="hidden w-72 shrink-0 bg-sidebar text-sidebar-foreground dark:bg-[#1a1d21] dark:text-zinc-100 lg:block"
            data-app-chrome="true"
          >
            <Sidebar onClose={() => undefined} />
          </aside>
          {isMobile && (
            <aside
              className="absolute inset-0 z-0 bg-sidebar text-sidebar-foreground dark:bg-[#1a1d21] dark:text-zinc-100 lg:hidden"
              inert={mobileChannelsOpen ? undefined : true}
              data-testid="mobile-channel-sidebar"
              data-app-chrome="true"
            >
              <Sidebar onClose={closeChannels} />
            </aside>
          )}
          <main
            ref={setMainNode}
            className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background max-md:relative max-md:z-10 max-md:touch-pan-y max-md:transform-gpu max-md:transition-transform max-md:duration-200 max-md:ease-out"
            data-app-main="true"
            style={mainDragStyle}
            data-channel-dragging={mobileShellActive ? 'true' : 'false'}
            data-mobile-channels-open={mobileChannelsOpen ? 'true' : 'false'}
            {...openChannelsSwipeHandlers}
          >
            {children}
          </main>
        </div>
      </div>
    </TagSearchProvider>
  );
}
