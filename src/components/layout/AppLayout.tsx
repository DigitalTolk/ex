import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type WheelEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, type PanInfo } from 'motion/react';
import { Sidebar } from './Sidebar';
import { PanelResizeHandle } from './PanelResizeHandle';
import { usePanelWidth } from '@/hooks/usePanelWidth';
import { useLayoutTier } from '@/hooks/useLayoutTier';
import { SIDEBAR_WIDTH } from '@/lib/panel-width';
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
    /* istanbul ignore next -- the native capture listener below preventDefaults every scrollable case before this React-prop fallback runs (the defaultPrevented bail above), so canScroll is always false here; the block stays as belt-and-braces should the native listener ever be detached */
    if (canScroll) {
      scroller.scrollTop += event.deltaY;
      event.preventDefault();
    }
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

  // Compact tier (narrow desktop window / tablet band): the persistent
  // sidebar doesn't fit, so the top-bar toggle opens a desktop-styled overlay
  // sidebar instead of the mobile drawer — no gestures, no sheets, Escape and
  // backdrop-click dismiss it. Before this tier existed the 768-1023 band
  // rendered a hamburger that opened NOTHING (the drawer was isMobile-gated)
  // and <768 desktop windows fell into the touch UI.
  const tier = useLayoutTier();
  // Derived visibility: the overlay only ever EXISTS on the compact tier, so
  // growing to full (or shrinking to mobile) closes it by derivation — no
  // tier-watching effect needed.
  const [compactSidebarToggled, setCompactSidebarToggled] = useState(false);
  const compactSidebarOpen = compactSidebarToggled && tier === 'compact';
  useEffect(() => {
    if (!compactSidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCompactSidebarToggled(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compactSidebarOpen]);

  // Resizable persistent sidebar (desktop): dragged width persists across
  // sessions; profile settings offers the reset.
  const { width: sidebarWidth, handleProps: sidebarHandleProps } = usePanelWidth(
    SIDEBAR_WIDTH,
    'right',
    'Resize channel sidebar',
  );

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
          <AppTopBar
            onOpenChannels={tier === 'compact' ? () => setCompactSidebarToggled((v) => !v) : openChannelsWithAnimation}
            channelsButtonHidden={tier === 'compact' ? false : isHome || mobileChannelsOpen}
          />
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
            className="relative hidden shrink-0 bg-sidebar text-sidebar-foreground lg:block"
            style={{ width: sidebarWidth }}
            data-app-chrome="true"
            data-keyboard-surface="sidebar"
            data-testid="app-sidebar"
          >
            <Sidebar onClose={() => undefined} />
            <PanelResizeHandle edge="right" testID="sidebar-resize-handle" {...sidebarHandleProps} />
          </aside>
          {tier === 'compact' && compactSidebarOpen && (
            <>
              {/* Desktop-styled overlay: click-away backdrop + a bordered
                  panel. Deliberately NOT the mobile drawer — no swipe, no
                  inert page underneath, desktop row chrome. */}
              <div
                className="absolute inset-0 z-30 bg-black/30"
                data-testid="compact-sidebar-backdrop"
                onClick={() => setCompactSidebarToggled(false)}
              />
              <aside
                className="absolute inset-y-0 left-0 z-40 w-72 border-r border-border bg-sidebar text-sidebar-foreground shadow-xl"
                data-testid="compact-sidebar"
                data-app-chrome="true"
                data-keyboard-surface="sidebar"
              >
                <Sidebar onClose={() => setCompactSidebarToggled(false)} />
              </aside>
            </>
          )}
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
            className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background mobile:relative mobile:z-10 mobile:touch-pan-y mobile:transform-gpu mobile:transition-transform mobile:duration-200 mobile:ease-out"
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
