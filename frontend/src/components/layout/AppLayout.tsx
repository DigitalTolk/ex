import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type WheelEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, type PanInfo } from 'motion/react';
import { Sidebar } from './Sidebar';
import { AppTopBar } from './AppTopBar';
import { TagSearchProvider } from '@/context/TagSearchContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';
import { useDismissKeyboardOnScroll } from '@/hooks/useDismissKeyboardOnScroll';
import { useKeyboardSurfaceColor } from '@/hooks/useKeyboardSurfaceColor';
import { blurActiveInput } from '@/lib/blur-input';
import {
  channelDragTransform,
  clampChannelOffset,
  latchChannelSwipe,
  shouldCommitChannelSwipe,
} from '@/lib/channel-swipe';
import { UpdateBanner } from '@/components/UpdateBanner';
import { NotificationPermissionBanner } from '@/components/NotificationPermissionBanner';

interface AppLayoutProps {
  children: ReactNode;
}


export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isMobile = useIsMobile();
  // Mobile: dragging/scrolling outside the focused field dismisses the keyboard.
  useDismissKeyboardOnScroll();
  // Mobile: keep the native keyboard strip matching the focused surface.
  useKeyboardSurfaceColor();
  const [manualChannelsOpen, setManualChannelsOpen] = useState(false);
  const [channelDragOffset, setChannelDragOffset] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const appHeaderRef = useRef<HTMLDivElement>(null);
  const mobileChannelsOpen = isMobile && (isHome || manualChannelsOpen);

  /* v8 ignore start -- only called from the Motion pan handler, which fires only in a real browser */
  const canOpenChannelsFromGesture = useCallback((eventTarget: EventTarget | null) => {
    /* istanbul ignore next -- only called when !mobileChannelsOpen; on the home route mobileChannelsOpen is always true on mobile, so isHome is never true here */
    if (isHome) return false;
    if (eventTarget instanceof Element && eventTarget.closest('[data-mobile-right-sidebar="true"]')) return false;
    if (document.querySelector('[data-mobile-right-sidebar="true"]')) return false;
    return true;
  }, [isHome]);
  /* v8 ignore stop */

  const openChannelsWithAnimation = useCallback(() => {
    setChannelDragOffset(0);
    setManualChannelsOpen(true);
  }, []);

  const closeChannels = useCallback(() => {
    setChannelDragOffset(0);
    setManualChannelsOpen(false);
  }, []);

  // Android/browser Back closes a manually-opened drawer instead of leaving
  // the page (on the home route the drawer IS the page, and it opens via
  // isHome — not manualChannelsOpen — so this never arms there).
  useMobileBackClose(manualChannelsOpen, closeChannels);

  // Per-swipe "committed" latch. Once a gesture has crossed the axis
  // lock (clearly horizontal), we keep tracking finger movement even
  // if the user wobbles vertically — the previous implementation
  // reset the offset to 0 on every wobble, causing the "drag glitches
  // / impossible to close mid-flick" symptom the user reported.
  const swipeCommittedRef = useRef<'open' | 'close' | null>(null);

  // Motion pan-gesture replacement for the old react-swipeable channel
  // drag-to-open. The decision logic lives in lib/channel-swipe (unit
  // tested); these handlers are thin Motion wiring. Motion's pan needs a
  // real browser, so the handler bodies are coverage-ignored — the logic
  // they call is covered in channel-swipe.test.
  /* v8 ignore start -- Motion's pointer-based pan gesture only fires in a real browser, not jsdom; the decision logic is unit-tested in channel-swipe.test */
  const onChannelPanStart = useCallback(() => {
    swipeCommittedRef.current = null;
  }, []);

  const onChannelPan = useCallback(
    /* istanbul ignore next -- driven by Motion pan; logic covered in channel-swipe.test */
    (event: PointerEvent, info: PanInfo) => {
      if (!isMobile) return;
      const startX = info.point.x - info.offset.x;
      if (swipeCommittedRef.current === null) {
        const intent = latchChannelSwipe({
          absX: Math.abs(info.offset.x),
          absY: Math.abs(info.offset.y),
          deltaX: info.offset.x,
          startX,
          mobileChannelsOpen,
          canOpen: canOpenChannelsFromGesture(event.target as EventTarget | null),
        });
        if (!intent) return;
        swipeCommittedRef.current = intent;
        blurActiveInput();
      }
      const viewportWidth = typeof window === 'undefined' ? Infinity : window.innerWidth;
      setChannelDragOffset(clampChannelOffset(swipeCommittedRef.current, info.offset.x, viewportWidth));
    },
    [isMobile, mobileChannelsOpen, canOpenChannelsFromGesture],
  );

  const onChannelPanEnd = useCallback(
    /* istanbul ignore next -- driven by Motion pan; logic covered in channel-swipe.test */
    (_event: PointerEvent, info: PanInfo) => {
      const committed = swipeCommittedRef.current;
      swipeCommittedRef.current = null;
      if (!committed) {
        setChannelDragOffset(0);
        return;
      }
      // react-swipeable velocity was px/ms; Motion's is px/s.
      const commit = shouldCommitChannelSwipe({
        absX: Math.abs(info.offset.x),
        velocityPxPerMs: Math.abs(info.velocity.x) / 1000,
      });
      if (commit && committed === 'open' && info.offset.x > 0) {
        setManualChannelsOpen(true);
      } else if (commit && committed === 'close' && info.offset.x < 0) {
        setManualChannelsOpen(false);
      }
      setChannelDragOffset(0);
    },
    [],
  );
  /* v8 ignore stop */

  const setMainNode = useCallback((node: HTMLElement | null) => {
    mainRef.current = node;
  }, []);
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
    /* istanbul ignore next -- setMainNode always attaches mainRef before any wheel fires; the document fallback is defensive */
    const root = mainRef.current ?? document;
    const scroller = root.querySelector<HTMLElement>('[data-page-scroll="true"], [data-testid="page-container"]');
    if (!scroller) return;
    const canScroll = scroller.scrollHeight > scroller.clientHeight;
    /* istanbul ignore next -- a scrollable scroller is always preventDefaulted first by the native capture listener below, so forwardHeaderWheel only ever sees a non-scrollable scroller (canScroll false) */
    if (!canScroll) return;
    scroller.scrollTop += event.deltaY;
    event.preventDefault();
  }, [isMobile]);
  /* v8 ignore stop */
  /* v8 ignore start -- real wheel propagation is covered by browser interaction tests/manual browser behavior, not jsdom. */
  useEffect(() => {
    const node = appHeaderRef.current;
    /* istanbul ignore next -- appHeaderRef is always attached after mount; the null guard is defensive */
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
      /* istanbul ignore next -- setMainNode always attaches mainRef before any wheel fires; the document fallback is defensive */
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
    const transform = channelDragTransform(channelDragOffset, mobileChannelsOpen);
    // The live-drag offset is only ever non-zero during a Motion pan, so
    // the transition:'none' arm isn't reachable in jsdom.
    /* istanbul ignore next -- driven by Motion pan; channelDragTransform is unit-tested in channel-swipe.test */
    return channelDragOffset !== 0 ? { transform, transition: 'none' } : { transform };
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
          <AppTopBar onOpenChannels={openChannelsWithAnimation} channelsButtonHidden={isHome || mobileChannelsOpen} />
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
            data-keyboard-surface="sidebar"
          >
            <Sidebar onClose={() => undefined} />
          </aside>
          {isMobile && (
            <aside
              className="absolute inset-0 z-0 bg-sidebar text-sidebar-foreground lg:hidden"
              inert={mobileChannelsOpen ? undefined : true}
              data-testid="mobile-channel-sidebar"
              data-app-chrome="true"
              data-keyboard-surface="sidebar"
            >
              <Sidebar onClose={closeChannels} />
            </aside>
          )}
          <motion.main
            ref={setMainNode}
            className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background max-md:relative max-md:z-10 max-md:touch-pan-y max-md:transform-gpu max-md:transition-transform max-md:duration-200 max-md:ease-out"
            data-app-main="true"
            style={mainDragStyle}
            data-channel-dragging={mobileShellActive ? 'true' : 'false'}
            data-mobile-channels-open={mobileChannelsOpen ? 'true' : 'false'}
            onPanStart={onChannelPanStart}
            onPan={onChannelPan}
            onPanEnd={onChannelPanEnd}
          >
            {children}
          </motion.main>
        </div>
      </div>
    </TagSearchProvider>
  );
}
