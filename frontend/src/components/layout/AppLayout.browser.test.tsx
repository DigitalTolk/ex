import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppLayout } from './AppLayout';
import { Header } from './Header';
import { PageContainer } from './PageContainer';
import { SidePanel } from '@/components/chat/SidePanel';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

vi.mock('@/components/SearchBar', () => ({
  SearchBar: () => <div aria-label="Search">Search</div>,
}));

vi.mock('./Sidebar', () => ({
  Sidebar: () => <div>Sidebar</div>,
}));

vi.mock('./AppTopBar', () => ({
  AppTopBar: ({ onOpenChannels, channelsButtonHidden }: { onOpenChannels?: () => void; channelsButtonHidden?: boolean }) => (
    <header
      data-testid="app-shell-header"
      data-app-chrome="true"
      className="grid h-14 w-full shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-sidebar"
    >
      <button
        type="button"
        aria-label="Open channels"
        aria-hidden={channelsButtonHidden}
        tabIndex={channelsButtonHidden ? -1 : 0}
        onClick={onOpenChannels}
        className={channelsButtonHidden ? 'invisible' : ''}
      >
        menu
      </button>
      <div>
        <input aria-label="Search" />
      </div>
      <div>account</div>
    </header>
  ),
}));

vi.mock('@/components/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => null,
}));

vi.mock('@/hooks/useServerVersion', () => ({
  BUILD_DISPLAY_VERSION: 'browser-test',
  BUILD_VERSION: 'browser-test',
  setServerVersion: vi.fn(),
  useServerVersion: () => ({ outdated: true }),
}));

const channel = {
  id: 'ch-1',
  name: 'very-long-channel-name-that-wraps-the-mobile-header',
  slug: 'very-long-channel-name-that-wraps-the-mobile-header',
  type: 'public' as const,
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-05-08T10:00:00.000Z',
};

function LayoutHarness({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={['/threads']}>
      <div style={{ height: 500 }}>
        <AppLayout>{children}</AppLayout>
      </div>
    </MemoryRouter>
  );
}

// Motion's pan gesture is pointer-based: it binds `pointerdown` on the
// element and `pointermove`/`pointerup` on the window, throttling the
// offset updates through requestAnimationFrame. We drive the real gesture
// by dispatching genuine PointerEvents and letting frames settle — the
// decision logic itself is unit-tested in lib/channel-swipe.test.
function pointer(target: EventTarget, type: string, x: number, y: number) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
  return event;
}

// Begin a pan at (x, y) on `element`, then drag through the given points
// (dispatched on the window, where Motion listens for moves).
function panMove(element: Element, start: [number, number], ...points: Array<[number, number]>) {
  pointer(element, 'pointerdown', start[0], start[1]);
  for (const [x, y] of points) pointer(window, 'pointermove', x, y);
}

function panEnd(point: [number, number]) {
  pointer(window, 'pointerup', point[0], point[1]);
}

describe('AppLayout browser behavior', () => {
  it('uses a distinct light chrome color in light mode instead of dark or pure-white shell', async () => {
    document.documentElement.classList.remove('dark');

    await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div>Thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );

    const header = document.querySelector('[data-testid="app-shell-header"]') as HTMLElement | null;
    const sidebar = document.querySelector('[data-app-chrome="true"] aside, aside[data-app-chrome="true"]') as HTMLElement | null;
    expect(header).not.toBeNull();
    expect(getComputedStyle(header!).backgroundColor).not.toBe('rgb(26, 29, 33)');
    if (sidebar) {
      const sidebarBg = getComputedStyle(sidebar).backgroundColor;
      expect(sidebarBg).not.toBe('rgb(26, 29, 33)');
      expect(sidebarBg).not.toBe('rgb(255, 255, 255)');
    }
  });

  it('keeps the reload banner visible below the app header', async () => {
    const screen = await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div style={{ height: 1200 }}>Thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );

    const reload = screen.getByTestId('update-banner-reload');
    await expect.element(reload).toBeVisible();

    const appHeader = document.querySelector('[data-testid="app-shell-header"]');
    const banner = document.querySelector('[data-testid="update-banner"]') as HTMLElement | null;
    expect(appHeader).not.toBeNull();
    expect(banner).not.toBeNull();
    expect(banner!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      Math.floor(appHeader!.getBoundingClientRect().bottom),
    );
    expectPaintedAtCenter(banner!, '[data-testid="update-banner"]');
  });

  it('blurs the focused composer when mobile channel-sidebar swipe begins', async () => {
    if (window.innerWidth > 767) return;

    await render(
      <LayoutHarness>
        <input aria-label="Message input" />
      </LayoutHarness>,
    );

    const input = document.querySelector('input[aria-label="Message input"]') as HTMLInputElement | null;
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement | null;
    expect(input).not.toBeNull();
    expect(main).not.toBeNull();

    input!.focus();
    expect(document.activeElement).toBe(input);

    panMove(main!, [12, 220], [60, 224], [92, 226]);

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(input);
      expect(main!.dataset.channelDragging).toBe('true');
    });
    panEnd([92, 226]);
  });

  it('never opens the channel drawer from a swipe that starts on a right panel', async () => {
    if (window.innerWidth > 767) return;

    await render(
      <LayoutHarness>
        {/* Stands in for MemberList/SidePanel: the mobile right-panel marker. */}
        <div data-mobile-right-sidebar="true" style={{ position: 'fixed', inset: 0 }}>
          <div data-testid="panel-body" style={{ height: 300 }} />
        </div>
      </LayoutHarness>,
    );

    const main = document.querySelector('[data-app-main="true"]') as HTMLElement | null;
    const panelBody = document.querySelector('[data-testid="panel-body"]') as HTMLElement | null;
    expect(main).not.toBeNull();
    expect(panelBody).not.toBeNull();

    // The edge swipe starts ON the panel: the gesture guard must refuse to
    // arm the drawer (a pan inside a right panel is that panel's gesture).
    // Moves are dispatched on the panel itself (not window) so the pan-start
    // event's target is the panel element, as it is under a real finger.
    pointer(panelBody!, 'pointerdown', 12, 220);
    pointer(panelBody!, 'pointermove', 60, 224);
    pointer(panelBody!, 'pointermove', 92, 226);
    await new Promise((r) => setTimeout(r, 80));
    expect(main!.dataset.channelDragging).not.toBe('true');
    panEnd([92, 226]);
  });

  it('allows vertical scrolling gestures on the mobile main content', async () => {
    if (window.innerWidth > 767) return;

    await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div style={{ height: 1600 }}>Scrollable thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );

    const main = document.querySelector('[data-app-main="true"]') as HTMLElement | null;
    const scroller = document.querySelector('[data-page-scroll="true"]') as HTMLElement | null;
    expect(main).not.toBeNull();
    expect(scroller).not.toBeNull();

    // A predominantly vertical pan never latches (absY >= absX), so the
    // channel drawer stays put and native scrolling is left to the browser.
    panMove(main!, [120, 420], [122, 340], [122, 260]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main!.dataset.channelDragging).toBe('false');
    panEnd([122, 260]);
  });

  it('blocks page scrolling only after an intentional mobile edge swipe starts opening channels', async () => {
    if (window.innerWidth > 767) return;

    await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div style={{ height: 1600 }}>Scrollable thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );

    const main = document.querySelector('[data-app-main="true"]') as HTMLElement | null;
    expect(main).not.toBeNull();

    // An intentional left-edge horizontal pan latches "open" and starts
    // dragging the drawer in, which flips the channel-dragging flag.
    panMove(main!, [12, 420], [60, 422], [96, 424]);

    await vi.waitFor(() => {
      expect(main!.dataset.channelDragging).toBe('true');
    });
    panEnd([96, 424]);
  });

  it('places mobile right panels below the measured channel header, including taller headers', async () => {
    const screen = await render(
      <LayoutHarness>
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <Header channel={channel} memberCount={3} canEdit onDescriptionSave={vi.fn()} />
            <div className="min-h-0 flex-1">Messages</div>
          </div>
          <SidePanel title="Pinned" ariaLabel="Pinned messages" closeLabel="Close pinned messages" onClose={vi.fn()}>
            <div>Pinned content</div>
          </SidePanel>
        </div>
      </LayoutHarness>,
    );

    if (window.innerWidth > 767) {
      await expect.element(screen.getByText('Pinned content')).toBeVisible();
      return;
    }

    await screen.getByText(channel.name).click();

    const header = document.querySelector('[data-testid="channel-header-shell"]') as HTMLElement | null;
    const panel = document.querySelector('[aria-label="Pinned messages"]') as HTMLElement | null;
    expect(header).not.toBeNull();
    expect(panel).not.toBeNull();

    await vi.waitFor(() => {
      const headerBottom = header!.getBoundingClientRect().bottom;
      const panelTop = panel!.getBoundingClientRect().top;
      const gap = panelTop - headerBottom;
      expect(gap).toBeGreaterThanOrEqual(-0.5);
      expect(gap).toBeLessThanOrEqual(1);
    });
    expectPaintedAtCenter(panel!, '[aria-label="Pinned messages"]');
  });

  // Coverage extension — exercises sidebar open/close + remaining swipe
  // gate branches that the visual tests above don't reach.

  it('clicking the mobile menu button opens the channels sidebar', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads">
              <div>Thread content</div>
            </PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const menu = document.querySelector('button[aria-label="Open channels"]') as HTMLButtonElement | null;
    expect(menu).not.toBeNull();
    menu!.click();
    await vi.waitFor(() => {
      // Sidebar mock renders "Sidebar"; it becomes visible when the
      // mobile drawer opens.
      expect(document.body.textContent).toContain('Sidebar');
    });
  });

  it('home route on mobile auto-opens the channels sidebar (no menu click needed)', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <div>Home content</div>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    expect(document.body.textContent).toContain('Sidebar');
  });

  it('desktop layout always shows the sidebar regardless of mobile drawer state', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads">
              <div>Thread content</div>
            </PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    expect(document.body.textContent).toContain('Sidebar');
  });

  it('aborts the channel-open swipe when a right-side sheet is open', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div data-mobile-right-sidebar="true" style={{ position: 'fixed', inset: 0, zIndex: 50 }}>
          Right Sheet
        </div>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads">
              <div>Thread content</div>
            </PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // A right-side sheet is open, so the edge-from-left open swipe is refused.
    panMove(main, [12, 420], [60, 422], [100, 424]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main.dataset.channelDragging).toBe('false');
    panEnd([100, 424]);
  });

  it('commits opening the drawer on a long edge swipe and tracks the live transform', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads"><div>Thread content</div></PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    panMove(main, [12, 300], [70, 304], [170, 306]);
    // Mid-drag: the main element carries a live translate3d(calc(...)) transform
    // (mainDragStyle's channelDragOffset !== 0 branch).
    await vi.waitFor(() => {
      expect(main.dataset.channelDragging).toBe('true');
      expect(main.style.transform).toContain('calc');
    });
    // A >80px travel commits the open.
    panEnd([170, 306]);
    await vi.waitFor(() => {
      expect(main.dataset.mobileChannelsOpen).toBe('true');
    });
  });

  it('commits closing the drawer on a leftward swipe when channels are open', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads"><div>Thread content</div></PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // Open via the menu button first (non-home route, so it can also close).
    (document.querySelector('button[aria-label="Open channels"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(main.dataset.mobileChannelsOpen).toBe('true'));
    // Swipe left past the threshold to close. Confirm the close intent
    // latches mid-drag (negative blend onto the 100vw resting position)
    // before releasing past the commit threshold.
    panMove(main, [200, 300], [120, 304], [40, 306]);
    await vi.waitFor(() => {
      expect(main.style.transform).toContain('100vw');
      expect(main.style.transform).toMatch(/-\s*\d+px/);
    });
    panEnd([40, 306]);
    await vi.waitFor(() => expect(main.dataset.mobileChannelsOpen).toBe('false'));
  });

  it('forwards wheel events over the app header to the page scroller (desktop)', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div style={{ height: 2000 }}>Tall thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );
    const headerInner = document.querySelector('[data-testid="app-shell-header"]') as HTMLElement;
    const scroller = document.querySelector('[data-page-scroll="true"]') as HTMLElement;
    expect(scroller).not.toBeNull();
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
    const before = scroller.scrollTop;
    // A wheel over the (non-input) header forwards its deltaY to the page
    // scroller via both the React onWheel and the native capture listener.
    headerInner.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(before));
  });

  it('drag offset clears after a touchend that did not cross the open threshold', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads">
              <div>Thread content</div>
            </PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    panMove(main, [12, 420], [30, 422], [40, 424]); // 28px — below the 80px threshold
    panEnd([40, 424]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main.dataset.channelDragging).toBe('false');
  });

  // ---- Additional branch coverage ----

  it('a vertical drag past the axis-lock hands off to native scroll (absY >= absX)', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <LayoutHarness>
        <PageContainer title="Threads">
          <div style={{ height: 1600 }}>Scrollable thread content</div>
        </PageContainer>
      </LayoutHarness>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // absX = 20 (>= axis-lock 12) but absY = 60 >= absX → vertical wins, no latch.
    panMove(main, [120, 400], [130, 430], [140, 460]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main.dataset.channelDragging).toBe('false');
    panEnd([140, 460]);
  });

  it('aborts the open swipe when the gesture starts on an element inside a right-side sheet', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads">
              {/* The sheet lives INSIDE the swipeable main so the gesture's
                  event target is itself within the right sidebar — exercises
                  the eventTarget.closest('[data-mobile-right-sidebar]') arm. */}
              <div data-mobile-right-sidebar="true" data-testid="inner-sheet" style={{ height: 200 }}>
                Inner sheet
              </div>
            </PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const sheet = document.querySelector('[data-testid="inner-sheet"]') as HTMLElement;
    // The pointerdown originates on an element inside the right sidebar, so
    // canOpenChannelsFromGesture refuses via the eventTarget.closest() arm.
    panMove(sheet, [12, 300], [60, 302], [100, 304]);
    await new Promise((r) => setTimeout(r, 40));
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    expect(main.dataset.channelDragging).toBe('false');
    panEnd([100, 304]);
  });

  it('clears the drag offset when a latched swipe ends without crossing the threshold (committed but short)', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads"><div>Thread content</div></PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // Latch open (edge start, absX>=12, horizontal), then end with total
    // travel below the 80px pixel threshold and low velocity → no commit.
    panMove(main, [10, 300], [25, 301], [40, 302]);
    await vi.waitFor(() => expect(main.dataset.channelDragging).toBe('true'));
    panEnd([40, 302]);
    await vi.waitFor(() => {
      expect(main.dataset.channelDragging).toBe('false');
      expect(main.dataset.mobileChannelsOpen).toBe('false');
    });
  });

  it('a tiny swipe that never latches clears the offset on release (uncommitted touchend)', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads"><div>Thread content</div></PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // A 6px move never crosses the 12px axis-lock, so swipeCommittedRef
    // stays null → onChannelPanEnd takes the !committed branch and resets
    // the offset to 0.
    panMove(main, [100, 300], [103, 301], [106, 301]);
    panEnd([106, 301]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main.dataset.channelDragging).toBe('false');
    expect(main.dataset.mobileChannelsOpen).toBe('false');
  });

  it('forwards a header wheel to nothing when the page has no scroll container', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <LayoutHarness>
        {/* No PageContainer → no [data-page-scroll] element exists, so the
            native capture handler bails without preventDefault and the React
            forwardHeaderWheel reaches its "no scroller" return. */}
        <div style={{ height: 50 }}>Plain content, no scroll container</div>
      </LayoutHarness>,
    );
    const headerInner = document.querySelector('[data-testid="app-shell-header"]') as HTMLElement;
    expect(document.querySelector('[data-page-scroll="true"]')).toBeNull();
    const ev = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    headerInner.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 20));
    expect(ev.defaultPrevented).toBe(false);
  });

  it('renders the live closing transform (negative offset) while dragging an open drawer left', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads"><div>Thread content</div></PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // Open the drawer first.
    (document.querySelector('button[aria-label="Open channels"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(main.dataset.mobileChannelsOpen).toBe('true'));
    // Drag left to start closing → channelDragOffset is negative, so
    // mainDragStyle uses restingX=100vw and the '-' sign branch.
    panMove(main, [300, 300], [260, 302], [230, 304]);
    await vi.waitFor(() => {
      // restingX=100vw (open) blended with a negative drag offset. The
      // browser re-serializes the calc(), so assert on its parts.
      expect(main.style.transform).toContain('100vw');
      expect(main.style.transform).toMatch(/-\s*\d+px/);
    });
    panEnd([230, 304]);
  });

  it('clamps the live open offset to a positive translate while latched', async () => {
    if (window.innerWidth > 767) return;
    await render(
      <MemoryRouter initialEntries={['/threads']}>
        <div style={{ height: 500 }}>
          <AppLayout>
            <PageContainer title="Threads"><div>Thread content</div></PageContainer>
          </AppLayout>
        </div>
      </MemoryRouter>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // Latch open from the edge; mid-drag the transform blends a positive
    // offset onto the closed resting position (0px). The browser collapses
    // calc(0px + Npx) to calc(Npx), so assert on the positive pixel value.
    panMove(main, [10, 300], [40, 301], [70, 302]);
    await vi.waitFor(() => {
      expect(main.dataset.channelDragging).toBe('true');
      expect(main.style.transform).toMatch(/calc\(\s*\d+px\s*\)/);
      expect(main.style.transform).not.toContain('-');
    });
    panEnd([70, 302]);
  });

  it('on desktop the swipe handler short-circuits because the layout is not mobile', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <LayoutHarness>
        <PageContainer title="Threads"><div>Thread content</div></PageContainer>
      </LayoutHarness>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // Motion's onPan fires, but isMobile is false → onChannelPan early-returns.
    panMove(main, [12, 300], [60, 302], [120, 304]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main.dataset.channelDragging).toBe('false');
    panEnd([120, 304]);
  });

  it('header wheel over a non-scrollable page is a no-op (no scroller to forward to)', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <LayoutHarness>
        {/* Short content → the page scroller is NOT scrollable, so neither
            the native capture handler nor the React onWheel forwards. */}
        <PageContainer title="Threads"><div style={{ height: 10 }}>Tiny</div></PageContainer>
      </LayoutHarness>,
    );
    const headerInner = document.querySelector('[data-testid="app-shell-header"]') as HTMLElement;
    const scroller = document.querySelector('[data-page-scroll="true"]') as HTMLElement;
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight));
    const ev = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    headerInner.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 20));
    // No scroller could be scrolled, and nothing was prevented.
    expect(scroller.scrollTop).toBe(0);
  });

  it('header wheel originating from a focusable input is ignored (input guard)', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <LayoutHarness>
        <PageContainer title="Threads"><div style={{ height: 2000 }}>Tall thread content</div></PageContainer>
      </LayoutHarness>,
    );
    const headerInput = document.querySelector('[data-testid="app-shell-header"] input') as HTMLInputElement;
    const scroller = document.querySelector('[data-page-scroll="true"]') as HTMLElement;
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
    const before = scroller.scrollTop;
    // Wheel over the search input → both handlers bail at the input guard,
    // so the scroller is left untouched.
    headerInput.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(scroller.scrollTop).toBe(before);
  });

  it('a defaultPrevented wheel over the header is ignored by the forwarders', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <LayoutHarness>
        <PageContainer title="Threads"><div style={{ height: 2000 }}>Tall thread content</div></PageContainer>
      </LayoutHarness>,
    );
    const headerInner = document.querySelector('[data-testid="app-shell-header"]') as HTMLElement;
    const scroller = document.querySelector('[data-page-scroll="true"]') as HTMLElement;
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
    const before = scroller.scrollTop;
    const ev = new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true });
    ev.preventDefault(); // already defaultPrevented before it reaches the handlers
    headerInner.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 20));
    expect(scroller.scrollTop).toBe(before);
  });

  it('a wheel outside the app header is ignored by the native document listener', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <LayoutHarness>
        <PageContainer title="Threads"><div style={{ height: 2000 }}>Tall thread content</div></PageContainer>
      </LayoutHarness>,
    );
    const scroller = document.querySelector('[data-page-scroll="true"]') as HTMLElement;
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
    const before = scroller.scrollTop;
    // A wheel dispatched on a node that is NOT inside the app header → the
    // document-capture listener bails at the node.contains(target) guard.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(scroller.scrollTop).toBe(before);
    outside.remove();
  });
});
