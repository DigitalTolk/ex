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

function touchPoint(element: Element, x: number, y: number) {
  return { identifier: 1, target: element, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y };
}

function dispatchTouch(element: Element, type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === 'touchend' ? [] : [touchPoint(element, x, y)];
  const changedTouches = [touchPoint(element, x, y)];
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'targetTouches', { value: touches });
  Object.defineProperty(event, 'changedTouches', { value: changedTouches });
  element.dispatchEvent(event);
  return event;
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

    dispatchTouch(main!, 'touchstart', 12, 220);
    dispatchTouch(main!, 'touchmove', 92, 226);

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(input);
      expect(main!.dataset.channelDragging).toBe('true');
    });
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

    dispatchTouch(main!, 'touchstart', 120, 420);
    const verticalMove = dispatchTouch(main!, 'touchmove', 122, 260);

    expect(verticalMove.defaultPrevented).toBe(false);
    expect(main!.dataset.channelDragging).toBe('false');
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

    dispatchTouch(main!, 'touchstart', 12, 420);
    const horizontalMove = dispatchTouch(main!, 'touchmove', 96, 424);

    await vi.waitFor(() => {
      expect(horizontalMove.defaultPrevented).toBe(true);
      expect(main!.dataset.channelDragging).toBe('true');
    });
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
    dispatchTouch(main, 'touchstart', 12, 420);
    const move = dispatchTouch(main, 'touchmove', 100, 424);
    // The right sheet blocks edge-from-left → no preventDefault.
    await new Promise((r) => setTimeout(r, 20));
    expect(move.defaultPrevented).toBe(false);
    expect(main.dataset.channelDragging).toBe('false');
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
    dispatchTouch(main, 'touchstart', 12, 300);
    dispatchTouch(main, 'touchmove', 70, 304);
    dispatchTouch(main, 'touchmove', 170, 306);
    // Mid-drag: the main element carries a live translate3d(calc(...)) transform
    // (mainDragStyle's channelDragOffset !== 0 branch).
    await vi.waitFor(() => {
      expect(main.dataset.channelDragging).toBe('true');
      expect(main.style.transform).toContain('calc');
    });
    // A >80px travel commits the open.
    dispatchTouch(main, 'touchend', 170, 306);
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
    // Swipe left past the threshold to close.
    dispatchTouch(main, 'touchstart', 200, 300);
    dispatchTouch(main, 'touchmove', 120, 304);
    dispatchTouch(main, 'touchmove', 30, 306);
    dispatchTouch(main, 'touchend', 30, 306);
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
    dispatchTouch(main, 'touchstart', 12, 420);
    dispatchTouch(main, 'touchmove', 40, 424); // 28px — below the 72px threshold
    dispatchTouch(main, 'touchend', 40, 424);
    await new Promise((r) => setTimeout(r, 20));
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
    dispatchTouch(main, 'touchstart', 120, 400);
    const move = dispatchTouch(main, 'touchmove', 140, 460);
    await new Promise((r) => setTimeout(r, 20));
    expect(move.defaultPrevented).toBe(false);
    expect(main.dataset.channelDragging).toBe('false');
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
    dispatchTouch(sheet, 'touchstart', 12, 300);
    const move = dispatchTouch(sheet, 'touchmove', 100, 304);
    await new Promise((r) => setTimeout(r, 20));
    expect(move.defaultPrevented).toBe(false);
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    expect(main.dataset.channelDragging).toBe('false');
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
    // travel below the 80px pixel threshold and 0 velocity → no commit.
    dispatchTouch(main, 'touchstart', 10, 300);
    dispatchTouch(main, 'touchmove', 40, 302);
    await vi.waitFor(() => expect(main.dataset.channelDragging).toBe('true'));
    dispatchTouch(main, 'touchend', 40, 302);
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
    // A 6px move registers a swipe (>= delta 4) but never crosses the
    // 12px axis-lock, so swipeCommittedRef stays null → onSwiped takes the
    // !committed branch and resets the offset to 0.
    dispatchTouch(main, 'touchstart', 100, 300);
    dispatchTouch(main, 'touchmove', 106, 301);
    dispatchTouch(main, 'touchend', 106, 301);
    await new Promise((r) => setTimeout(r, 20));
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
    dispatchTouch(main, 'touchstart', 300, 300);
    dispatchTouch(main, 'touchmove', 260, 302);
    dispatchTouch(main, 'touchmove', 230, 304);
    await vi.waitFor(() => {
      // restingX=100vw (open) blended with a negative drag offset. The
      // browser re-serializes the calc(), so assert on its parts.
      expect(main.style.transform).toContain('100vw');
      expect(main.style.transform).toMatch(/-\s*\d+px/);
    });
    dispatchTouch(main, 'touchend', 230, 304);
  });

  it('ignores a non-cancelable touchmove during a latched swipe', async () => {
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
    dispatchTouch(main, 'touchstart', 10, 300);
    // A non-cancelable move still updates the offset but skips preventDefault.
    const ev = new Event('touchmove', { bubbles: true, cancelable: false });
    const tp = touchPoint(main, 80, 302);
    Object.defineProperty(ev, 'touches', { value: [tp] });
    Object.defineProperty(ev, 'targetTouches', { value: [tp] });
    Object.defineProperty(ev, 'changedTouches', { value: [tp] });
    main.dispatchEvent(ev);
    await vi.waitFor(() => expect(main.dataset.channelDragging).toBe('true'));
    expect(ev.defaultPrevented).toBe(false);
  });

  it('on desktop the swipe handler short-circuits because the layout is not mobile', async () => {
    if (window.innerWidth <= 767) return;
    await render(
      <LayoutHarness>
        <PageContainer title="Threads"><div>Thread content</div></PageContainer>
      </LayoutHarness>,
    );
    const main = document.querySelector('[data-app-main="true"]') as HTMLElement;
    // onSwiping fires (synthetic touch), but isMobile is false → early return.
    dispatchTouch(main, 'touchstart', 12, 300);
    dispatchTouch(main, 'touchmove', 120, 304);
    await new Promise((r) => setTimeout(r, 20));
    expect(main.dataset.channelDragging).toBe('false');
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
