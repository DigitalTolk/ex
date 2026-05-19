import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type WheelEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useSwipeable } from 'react-swipeable';
import { Sidebar } from './Sidebar';
import { AppTopBar } from './AppTopBar';
import { TagSearchProvider } from '@/context/TagSearchContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { UpdateBanner } from '@/components/UpdateBanner';
import { NotificationPermissionBanner } from '@/components/NotificationPermissionBanner';

interface AppLayoutProps {
  children: ReactNode;
}

// Commit thresholds — pixels OR velocity. A slow deliberate drag
// past CHANNEL_OPEN_PX_THRESHOLD commits, as does a quick flick that
// exceeds CHANNEL_OPEN_VELOCITY_THRESHOLD even if the absolute travel
// is short.
const CHANNEL_OPEN_PX_THRESHOLD = 80;
const CHANNEL_OPEN_VELOCITY_THRESHOLD = 0.45;
// Initial-axis gates so the gesture only kicks in when the user
// clearly intends a horizontal channel swipe (not a vertical scroll
// or a chat-area horizontal pan).
const CHANNEL_OPEN_EDGE_PX = 36;
const CHANNEL_OPEN_MIN_DELTA_TO_COMMIT = 56;
// Vertical drift tolerance _before_ the axis lock. After a horizontal
// drag is committed (passes the axis lock), vertical wobble no
// longer cancels — that was the source of "the drag glitches /
// resets mid-flick" complaints.
const CHANNEL_OPEN_AXIS_LOCK_PX = 12;

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
  const appHeaderRef = useRef<HTMLDivElement>(null);
  const mobileChannelsOpen = isMobile && (isHome || manualChannelsOpen);

  const canOpenChannelsFromGesture = useCallback((eventTarget: EventTarget | null) => {
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

  // Per-swipe "committed" latch. Once a gesture has crossed the axis
  // lock (clearly horizontal), we keep tracking finger movement even
  // if the user wobbles vertically — the previous implementation
  // reset the offset to 0 on every wobble, causing the "drag glitches
  // / impossible to close mid-flick" symptom the user reported.
  const swipeCommittedRef = useRef<'open' | 'close' | null>(null);

  const openChannelsSwipe = useSwipeable({
    delta: 4,
    trackMouse: false,
    // Don't unconditionally preventDefault on every touchmove — that
    // breaks native vertical scrolling. Our onSwiping callback below
    // calls event.preventDefault() only AFTER the gesture has latched
    // onto the horizontal axis, so vertical scrolls pass through.
    preventScrollOnSwipe: false,
    touchEventOptions: { passive: false },
    onSwipeStart: () => {
      swipeCommittedRef.current = null;
    },
    onSwiping: ({ absX, absY, deltaX, event, initial }) => {
      if (!isMobile) return;
      const eventTarget = event.target as EventTarget | null;

      // First, decide if the gesture has CLEARLY locked onto the
      // horizontal axis. Once latched, vertical jitter is ignored so
      // a slow drag or a long swipe doesn't get cancelled mid-flight.
      if (swipeCommittedRef.current === null) {
        if (absX < CHANNEL_OPEN_AXIS_LOCK_PX) {
          // Too early to tell — leave the resting transform alone so
          // the user's finger lift cleanly cancels.
          return;
        }
        if (absY >= absX) {
          // Vertical drag wins — let native scroll take over.
          return;
        }
        // Latch: which intent does this gesture express?
        const isEdgeStart = initial[0] <= CHANNEL_OPEN_EDGE_PX;
        if (!mobileChannelsOpen && deltaX > 0 && isEdgeStart && canOpenChannelsFromGesture(eventTarget)) {
          swipeCommittedRef.current = 'open';
          blurActiveInput();
        } else if (mobileChannelsOpen && deltaX < 0) {
          swipeCommittedRef.current = 'close';
          blurActiveInput();
        } else {
          return;
        }
      }

      // Past the latch — follow the finger. iOS swipe-back inertia
      // can briefly overshoot, so clamp to [-vw, vw].
      const viewportWidth = typeof window === 'undefined' ? Infinity : window.innerWidth;
      let offset = deltaX;
      if (swipeCommittedRef.current === 'open') {
        offset = Math.max(0, Math.min(viewportWidth, offset));
      } else {
        offset = Math.max(-viewportWidth, Math.min(0, offset));
      }
      if (event.cancelable) event.preventDefault();
      setChannelDragOffset(offset);
    },
    onSwiped: ({ absX, deltaX, velocity }) => {
      const committed = swipeCommittedRef.current;
      swipeCommittedRef.current = null;
      if (!committed) {
        setChannelDragOffset(0);
        return;
      }
      const flicked = velocity > CHANNEL_OPEN_VELOCITY_THRESHOLD;
      const meetsPixelThreshold = absX >= CHANNEL_OPEN_PX_THRESHOLD;
      const meetsMinDelta = absX >= CHANNEL_OPEN_MIN_DELTA_TO_COMMIT;
      const commit = (flicked && meetsMinDelta) || meetsPixelThreshold;
      if (commit && committed === 'open' && deltaX > 0) {
        setManualChannelsOpen(true);
      } else if (commit && committed === 'close' && deltaX < 0) {
        setManualChannelsOpen(false);
      }
      setChannelDragOffset(0);
    },
  });
  const { ref: openChannelsSwipeRef, ...openChannelsSwipeHandlers } = openChannelsSwipe;
  const setMainNode = useCallback((node: HTMLElement | null) => {
    mainRef.current = node;
    openChannelsSwipeRef(node);
  }, [openChannelsSwipeRef]);
  const mobileShellActive = isMobile && (mobileChannelsOpen || channelDragOffset !== 0);
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
    if (channelDragOffset !== 0) {
      // Live drag: blend the gesture delta on top of the resting
      // open/closed translate. Opening drags from 0 with positive
      // offset, closing drags from 100vw with negative offset.
      const restingX = mobileChannelsOpen ? `100vw` : `0px`;
      const sign = channelDragOffset > 0 ? '+' : '-';
      const abs = Math.round(Math.abs(channelDragOffset));
      return {
        transform: `translate3d(calc(${restingX} ${sign} ${abs}px), 0, 0)`,
        transition: 'none',
      };
    }
    return { transform: mobileChannelsOpen ? 'translate3d(100vw, 0, 0)' : 'translate3d(0, 0, 0)' };
  }, [channelDragOffset, isMobile, mobileChannelsOpen]);

  return (
    <TagSearchProvider>
      <div className="flex h-full flex-col overflow-hidden bg-sidebar">
        {/* Branded top bar — logo on the left, global search centred,
            theme/settings/account chips on the right. Behaviour for
            forwarding wheel events to the page scroller is preserved. */}
        <div
          ref={appHeaderRef}
          onWheel={forwardHeaderWheel}
        >
          <AppTopBar onOpenChannels={openChannelsWithAnimation} channelsButtonHidden={isHome} />
        </div>
        <div
          className="relative z-20 shrink-0 bg-sidebar"
          data-testid="app-layout-banners"
          data-app-chrome="true"
        >
          <UpdateBanner />
          <NotificationPermissionBanner />
        </div>

        <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background">
          <aside
            className="hidden w-72 shrink-0 bg-sidebar text-sidebar-foreground lg:block"
            data-app-chrome="true"
          >
            <Sidebar onClose={() => undefined} />
          </aside>
          {isMobile && (
            <aside
              className="absolute inset-0 z-0 bg-sidebar text-sidebar-foreground lg:hidden"
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
