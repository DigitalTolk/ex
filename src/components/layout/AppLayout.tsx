import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type WheelEvent } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { requestOpenChannels, takeOpenChannelsRequest, useOpenChannelsRequest } from '@/lib/mobile-nav';
import { isNativePlatform } from '@/lib/capacitor';
import { hasOpenBackOverlay } from '@/hooks/useMobileBackClose';
import { useLatestRef } from '@/hooks/useLatestRef';
import { Sidebar } from './Sidebar';
import { PanelResizeHandle } from './PanelResizeHandle';
import { usePanelWidth } from '@/hooks/usePanelWidth';
import { useLayoutTier } from '@/hooks/useLayoutTier';
import { SIDEBAR_WIDTH } from '@/lib/panel-width';
import { AppTopBar } from './AppTopBar';
import { AccountMenu } from './AccountMenu';
import { MobileTabBar } from './MobileTabBar';
import { useTextFieldFocused } from '@/hooks/useTextFieldFocused';
import { ActivityModeSwitch } from '@/components/activity/ActivityModeSwitch';
import { ActivityPanel } from '@/components/activity/ActivityPanel';
import { useSidebarModeStore } from '@/stores/sidebar-mode';
import { TagSearchProvider } from '@/context/TagSearchContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';
import { useDismissKeyboardOnScroll } from '@/hooks/useDismissKeyboardOnScroll';
import { useKeyboardSurfaceColor } from '@/hooks/useKeyboardSurfaceColor';
import { blurActiveInput } from '@/lib/blur-input';
import { useAxisSwipe, type AxisSwipeRelease } from '@/hooks/useAxisSwipe';
import { useSlide } from '@/hooks/useSlide';
import { SWIPE_SURFACE_ATTR, shouldCommitSwipe, swipeStartsOn } from '@/lib/swipe';
import { UpdateBanner } from '@/components/UpdateBanner';
import { LoadingBar } from '@/components/layout/LoadingBar';
import { NotificationPermissionBanner } from '@/components/NotificationPermissionBanner';
import { SCROLL_FADE_TOP, trackScrolledOffTop } from '@/lib/scroll-fade';

interface AppLayoutProps {
  children: ReactNode;
}

// The top of every sidebar surface. On the full tier the sidebar runs the
// whole window height, but its top strip (the top bar's height) stays empty:
// breathing room, a window-drag area, and where macOS traffic lights sit in
// the desktop app. The Home / Activity switch comes just below it.
function SidebarHeader({ topStrip = false }: { topStrip?: boolean }) {
  return (
    <div className="shrink-0" data-sidebar-header="true">
      {topStrip && <div className="h-12 [-webkit-app-region:drag]" data-testid="sidebar-top-strip" aria-hidden="true" />}
      {/* No bottom padding: the list below scrolls right up to the switch
          (fading under it), and carries the gap at rest itself. */}
      <div className={`px-3 ${topStrip ? '' : 'pt-3'}`}>
        <ActivityModeSwitch />
      </div>
    </div>
  );
}

// On a phone the Home / Activity switch moves to the bottom tab bar; the
// drawer just names the screen it shows. Home's list starts at the top of the
// screen instead, its name only read out.
function MobileSidebarTitle() {
  const mode = useSidebarModeStore((s) => s.mode);
  if (mode !== 'activity') {
    return (
      <>
        <h2 className="sr-only" data-testid="mobile-sidebar-title">Home</h2>
        <div className="h-2 shrink-0" aria-hidden="true" />
      </>
    );
  }
  return (
    <h2 className="shrink-0 px-4 pt-3 pb-3 text-xl leading-[150%] font-semibold" data-testid="mobile-sidebar-title">
      Activity
    </h2>
  );
}

// The sidebar's list: channels and DMs, or Activity. Memoized (with stable
// onClose callbacks) so layout state — a drawer drag, a sidebar resize — doesn't
// re-render the whole list.
const SidebarBody = memo(function SidebarBody({ onClose }: { onClose: () => void }) {
  const mode = useSidebarModeStore((s) => s.mode);
  const [scrolled, setScrolled] = useState(false);
  // Switching lists starts the new one at its top, unfaded.
  const [shownMode, setShownMode] = useState(mode);
  if (shownMode !== mode) {
    setShownMode(mode);
    setScrolled(false);
  }
  return (
    // isolate: the fades' z-index stays inside the list, never above the
    // phone tab bar or other chrome.
    <div className="relative isolate min-h-0 flex-1" onScrollCapture={trackScrolledOffTop(setScrolled)}>
      {mode === 'activity' ? <ActivityPanel onNavigate={onClose} /> : <Sidebar onClose={onClose} />}
      {/* Once scrolled, channels fade softly under the header. (Activity
          fades below its own filters instead.) */}
      {mode === 'home' && (
        <div
          className={`${SCROLL_FADE_TOP} top-0 ${scrolled ? 'opacity-100' : 'opacity-0'}`}
          aria-hidden="true"
          data-testid="sidebar-top-fade"
        />
      )}
    </div>
  );
});

// The persistent sidebar never closes.
const keepOpen = () => undefined;


export function AppLayout({ children }: AppLayoutProps) {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const isMobile = useIsMobile();
  // Mobile: dragging/scrolling outside the focused field dismisses the keyboard.
  useDismissKeyboardOnScroll();
  // Mobile: keep the native keyboard strip matching the focused surface.
  useKeyboardSurfaceColor();
  const [manualChannelsOpen, setManualChannelsOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const appHeaderRef = useRef<HTMLDivElement>(null);
  // Going somewhere closes a manually opened drawer — a pick from the
  // search sheet or a deep link has to land on the page, not under the list,
  // even when it is the conversation already open behind it (same path, new
  // ?thread= or #msg-). (Rows in the list close it themselves; this covers
  // everything else.)
  const [drawerLocation, setDrawerLocation] = useState(location.key);
  // A pick from the list on the home screen slides the conversation in at
  // once. Its navigation renders as a transition, the whole new page, and
  // the slide used to wait for that; now the page renders under the slide.
  // The route it goes to takes over from there.
  const [leavingHome, setLeavingHome] = useState(false);
  if (drawerLocation !== location.key) {
    setDrawerLocation(location.key);
    if (manualChannelsOpen) setManualChannelsOpen(false);
    if (leavingHome) setLeavingHome(false);
  }
  const mobileChannelsOpen = isMobile && ((isHome && !leavingHome) || manualChannelsOpen);
  const inConversation =
    matchPath('/channel/:id', location.pathname) !== null || matchPath('/conversation/:id', location.pathname) !== null;

  const openChannelsWithAnimation = useCallback(() => {
    setManualChannelsOpen(true);
  }, []);

  const closeChannels = useCallback(() => {
    setManualChannelsOpen(false);
  }, []);

  // A row in the list was picked: it navigates, and the list makes way.
  const leaveChannels = useCallback(() => {
    setManualChannelsOpen(false);
    setLeavingHome(true);
  }, []);

  // Android/browser Back closes a manually-opened drawer instead of leaving
  // the page (on the home route the drawer IS the page, and it opens via
  // isHome — not manualChannelsOpen — so this never arms there).
  // In the phone app the list is the root screen: its Back leaves the app.
  useMobileBackClose(manualChannelsOpen, closeChannels, { appRoot: true });

  // Phone: the conversation lies over the channel list. mainSlide is how far
  // it is slid aside: 0 covers the list, the viewport's width reveals it. A
  // swipe moves it with the finger; anything else that opens or closes the
  // list (a back button, a row, a route) slides it there, carrying the speed
  // of the swipe that committed it — on the compositor (hooks/useSlide), so
  // the page that opens can render while it slides.
  const mainSlide = useSlide(mainRef, isMobile && mobileChannelsOpen ? window.innerWidth : 0);
  const releaseVelocityRef = useRef(0);
  const [channelSwiping, setChannelSwiping] = useState(false);
  useLayoutEffect(() => {
    if (!isMobile) {
      mainSlide.set(0);
      return;
    }
    const velocity = releaseVelocityRef.current;
    releaseVelocityRef.current = 0;
    mainSlide.slideTo(mobileChannelsOpen ? window.innerWidth : 0, velocity);
  }, [isMobile, mobileChannelsOpen, mainSlide]);
  // Rotating the phone moves where an open list leaves the conversation —
  // at once, ending any slide still on its way to the old width.
  useEffect(() => {
    if (!isMobile) return;
    const onResize = () => mainSlide.set(mobileChannelsOpen ? window.innerWidth : 0);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isMobile, mobileChannelsOpen, mainSlide]);

  // Settle a released swipe of the conversation: one that was sliding it
  // aside to reveal the list, or back over it. Commit it into the drawer
  // state, or slide back to where it started.
  const settleChannelSwipe = (revealing: boolean, { value, velocity, aborted }: AxisSwipeRelease) => {
    setChannelSwiping(false);
    const travel = window.innerWidth;
    // Progress and speed towards where the swipe was going.
    const distance = revealing ? value : travel - value;
    const speed = revealing ? velocity : -velocity;
    if (!aborted && shouldCommitSwipe({ distance, velocity: speed, travel })) {
      releaseVelocityRef.current = velocity;
      setManualChannelsOpen(revealing);
      return;
    }
    mainSlide.slideTo(revealing ? 0 : travel, velocity);
  };
  // Swipe the conversation aside, from anywhere on it, to reveal the list.
  // Not while a right-hand panel covers it: that panel swipes itself away.
  const revealListSwipe = useAxisSwipe({
    enabled: isMobile && !mobileChannelsOpen,
    axis: 'x',
    value: mainSlide,
    range: () => [0, window.innerWidth],
    canStart: (target, surface) =>
      swipeStartsOn(target, surface) && !document.querySelector('[data-mobile-right-sidebar="true"]'),
    onStart: () => {
      setChannelSwiping(true);
      blurActiveInput();
    },
    onRelease: (release) => settleChannelSwipe(true, release),
  });
  // Swipe the list away to slide the conversation behind it back.
  const returnToConversationSwipe = useAxisSwipe({
    enabled: isMobile && manualChannelsOpen && !isHome,
    axis: 'x',
    value: mainSlide,
    range: () => [0, window.innerWidth],
    canStart: swipeStartsOn,
    onStart: () => setChannelSwiping(true),
    onRelease: (release) => settleChannelSwipe(false, release),
  });

  const setMainNode = useCallback((node: HTMLElement | null) => {
    mainRef.current = node;
  }, []);
  const mobileShellActive = isMobile && (mobileChannelsOpen || channelSwiping);

  // The phone app's Back (Android's button or edge gesture), asked before the
  // shell walks WebView history — a browser-style walk went chat to previous
  // chat, and stalled on same-URL overlay entries. Back closes an open
  // overlay; in a chat it shows the channel list (as the header back button
  // and the swipe do); on the list it hands the app to the background.
  // Elsewhere (a wider layout) the shell keeps walking history.
  const backStateRef = useLatestRef({ isMobile, mobileChannelsOpen });
  useEffect(() => {
    if (!isNativePlatform()) return;
    window.__exMobileBack = () => {
      if (hasOpenBackOverlay()) {
        window.history.back();
        return 'handled';
      }
      const { isMobile: phone, mobileChannelsOpen: listShown } = backStateRef.current;
      if (!phone) return undefined;
      if (listShown) return 'background';
      requestOpenChannels();
      return 'handled';
    };
    return () => {
      delete window.__exMobileBack;
    };
  }, [backStateRef]);
  /* v8 ignore start -- synthetic wheel support differs between jsdom and browsers; browser tests cover visibility around this surface. */
  /* istanbul ignore next -- synthetic wheel support differs between jsdom and browsers; browser tests cover visibility around this surface. */
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
  /* istanbul ignore next -- same dead defensive arm as the v8 ignore above */
  /* v8 ignore start -- real wheel propagation is covered by browser interaction tests/manual browser behavior, not jsdom. */
  /* istanbul ignore next -- real wheel propagation is covered by browser interaction tests/manual browser behavior, not jsdom. */
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
  /* istanbul ignore next -- same dead defensive arm as the v8 ignore above */
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
  const closeCompactSidebar = useCallback(() => setCompactSidebarToggled(false), []);

  // Something asks for the list: a conversation header's back button (phone),
  // or /activity (compact window, where the list is the overlay). A request
  // made before this mounted is served on mount.
  useEffect(() => {
    const serve = () => {
      if (!takeOpenChannelsRequest()) return;
      if (tier === 'compact') setCompactSidebarToggled(true);
      else openChannelsWithAnimation();
    };
    serve();
    return useOpenChannelsRequest.subscribe(serve);
  }, [tier, openChannelsWithAnimation]);
  useEffect(() => {
    if (!compactSidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The overlay is on top: the key is its (a right-hand panel stays open).
      e.preventDefault();
      setCompactSidebarToggled(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [compactSidebarOpen]);

  // Resizable persistent sidebar (desktop): dragged width persists across
  // sessions; profile settings offers the reset.
  const { width: sidebarWidth, handleProps: sidebarHandleProps } = usePanelWidth(
    SIDEBAR_WIDTH,
    'right',
    'Resize channel sidebar',
  );

  // Phone: the bottom tab bar belongs to the list screen (Home, Activity),
  // at its foot. A conversation slides in over it, the way a pushed screen
  // covers the tab bar in a native app — so opening or leaving the list
  // never resizes the conversation or the list mid-slide. It steps aside
  // while the keyboard is up. While it shows it covers the home indicator,
  // so the list above it drops its own bottom safe-area padding.
  const textFieldFocused = useTextFieldFocused(isMobile);

  return (
    <TagSearchProvider>
      <div className="flex h-full overflow-hidden bg-sidebar">
        {/* Persistent sidebar (full tier): runs the full window height, with
            the Home / Activity switch level with the top bar. Mounted only on
            that tier, so narrower layouts don't keep a hidden copy of the list
            (and its queries) alive. */}
        {tier === 'full' && (
          <aside
            className="relative flex shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border"
            style={{ width: sidebarWidth }}
            data-app-chrome="true"
            data-keyboard-surface="sidebar"
            data-testid="app-sidebar"
          >
            <SidebarHeader topStrip />
            <SidebarBody onClose={keepOpen} />
            <AccountMenu />
            <PanelResizeHandle edge="right" testID="sidebar-resize-handle" {...sidebarHandleProps} />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Top bar over the main column — global search centred. Behaviour
              for forwarding wheel events to the page scroller is preserved. */}
          {/* Phone: no top bar on the list screens or in a conversation
              (its header carries the back button; search is in the tab
              bar). Other pages keep it for their back button. */}
          <div
            ref={appHeaderRef}
            onWheel={forwardHeaderWheel}
            className={isMobile && (mobileChannelsOpen || inConversation || leavingHome) ? 'hidden' : undefined}
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
            {tier === 'compact' && compactSidebarOpen && (
              <>
                {/* Desktop-styled overlay: click-away backdrop + a bordered
                    panel. Deliberately NOT the mobile drawer — no swipe, no
                    inert page underneath, desktop row chrome. Both sit above
                    z-40: under 768px a thread/members panel covers the main
                    area at z-40 (RIGHT_PANEL_COVER_CLASS) and comes later in
                    the DOM, so at the same level it would paint over the
                    sidebar the hamburger just opened. */}
                <div
                  className="absolute inset-0 z-50 bg-black/30"
                  data-testid="compact-sidebar-backdrop"
                  onClick={() => setCompactSidebarToggled(false)}
                />
                <aside
                  className="absolute inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-border bg-sidebar text-sidebar-foreground shadow-xl"
                  data-testid="compact-sidebar"
                  data-app-chrome="true"
                  data-keyboard-surface="sidebar"
                >
                  <SidebarHeader />
                  <SidebarBody onClose={closeCompactSidebar} />
                  <AccountMenu />
                </aside>
              </>
            )}
            {isMobile && (
              <aside
                className="absolute inset-0 z-0 flex flex-col bg-sidebar text-sidebar-foreground touch-pan-y lg:hidden"
                style={textFieldFocused ? undefined : ({ '--bottom-safe-inset': '0px' } as CSSProperties)}
                inert={mobileChannelsOpen ? undefined : true}
                data-testid="mobile-channel-sidebar"
                data-app-chrome="true"
                data-keyboard-surface="sidebar"
                {...{ [SWIPE_SURFACE_ATTR]: 'x' }}
                {...returnToConversationSwipe}
              >
                <MobileSidebarTitle />
                <SidebarBody onClose={leaveChannels} />
                {/* Hidden, not unmounted, while typing: the bar owns the
                    account sheet and the dialogs it opens (status,
                    settings), which have text fields of their own. */}
                <MobileTabBar hidden={textFieldFocused} />
              </aside>
            )}
            {/* Phone: will-change keeps main the containing block of the
                fixed right-hand panels (Header measures their top from it)
                even at rest, where it has no transform at all. */}
            <main
              ref={setMainNode}
              className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background mobile:relative mobile:z-10 mobile:touch-pan-y mobile:will-change-transform"
              data-app-main="true"
              data-channel-dragging={mobileShellActive ? 'true' : 'false'}
              data-mobile-channels-open={mobileChannelsOpen ? 'true' : 'false'}
              {...(isMobile ? { [SWIPE_SURFACE_ATTR]: 'x' } : {})}
              {...revealListSwipe}
            >
              <LoadingBar />
              {children}
            </main>
          </div>
        </div>
      </div>
    </TagSearchProvider>
  );
}
