import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppLayout } from './AppLayout';
import { Header } from './Header';
import { PageContainer } from './PageContainer';
import { SidePanel } from '@/components/chat/SidePanel';
import { expectPaintedAtCenter } from '@/test/browser-assertions';
import { swipe } from '@/test/gestures';

// The sidebar header's Home / Activity switch reads the activity feed; these
// layout tests don't mount a QueryClient, so stand it (and the panel) in.
vi.mock('@/components/activity/ActivityModeSwitch', () => ({
  ActivityModeSwitch: () => <div data-testid="sidebar-mode-switch" />,
}));
// The phone tab bar reads the activity feed too.
vi.mock('./MobileTabBar', () => ({
  MobileTabBar: ({ hidden }: { hidden?: boolean }) => (
    <nav data-testid="mobile-tab-bar" data-hidden={hidden ? 'true' : 'false'}>
      <button type="button" data-testid="mobile-tab-home">Home</button>
    </nav>
  ),
}));
vi.mock('@/components/activity/ActivityPanel', () => ({
  ActivityPanel: () => <div data-testid="activity-panel" />,
}));
vi.mock('@/components/SearchBar', () => ({
  SearchBar: () => <div aria-label="Search">Search</div>,
}));

vi.mock('./Sidebar', () => ({
  Sidebar: ({ onClose }: { onClose?: () => void }) => (
    <div>
      Sidebar
      <button type="button" data-testid="sidebar-close-stub" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

vi.mock('./AccountMenu', () => ({ AccountMenu: () => <div data-testid="sidebar-account" /> }));
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
vi.mock('./LoadingBar', () => ({ LoadingBar: () => null }));

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

// The channel swipe (@use-gesture/react, via useAxisSwipe) listens for
// `pointerdown` on the surface and follows `pointermove`/`pointerup` on the
// window. These helpers hold a gesture open so a test can look at it
// mid-swipe; `swipe()` (test/gestures) drives a whole one with real timing.
// The release decision itself is unit-tested in lib/swipe.test.
function pointer(target: EventTarget, type: string, x: number, y: number) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    // A finger on the screen holds the primary "button".
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
  });
  target.dispatchEvent(event);
  return event;
}

// Begin a pan at (x, y) on `element`, then drag through the given points
// (dispatched on the window, where the swipe follows moves).
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

  it('closes a manually-opened channel drawer via the sidebar close callback', async () => {
    if (window.innerWidth > 767) return;

    await render(
      <LayoutHarness>
        <div>content</div>
      </LayoutHarness>,
    );

    const main = document.querySelector('[data-app-main="true"]') as HTMLElement | null;
    expect(main).not.toBeNull();

    // Open the drawer via the top-bar hamburger, then close it through the
    // Sidebar's onClose (the closeChannels callback).
    (document.querySelector('[aria-label="Open channels"]') as HTMLElement).click();
    await vi.waitFor(() => {
      expect(main!.dataset.mobileChannelsOpen).toBe('true');
    });
    (
      document.querySelector('[data-testid="mobile-channel-sidebar"] [data-testid="sidebar-close-stub"]') as HTMLElement
    ).click();
    await vi.waitFor(() => {
      expect(main!.dataset.mobileChannelsOpen).not.toBe('true');
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

  // Coverage extension — exercises sidebar open/close branches that the
  // visual tests above don't reach.

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

// The phone's conversation lies over the channel list: swipe it aside, from
// anywhere, to reveal the list; swipe the list away to slide it back.
describe('AppLayout channel swipe (phone)', () => {
  function renderAt(path: string, children: ReactNode = <PageContainer title="Threads"><div>Thread content</div></PageContainer>) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <div style={{ height: 500 }}>
          <AppLayout>{children}</AppLayout>
        </div>
      </MemoryRouter>,
    );
  }
  const main = () => document.querySelector('[data-app-main="true"]') as HTMLElement;
  const list = () => document.querySelector('[data-testid="mobile-channel-sidebar"]') as HTMLElement;
  // How far the conversation is slid aside.
  const slidX = () => new DOMMatrix(getComputedStyle(main()).transform).m41;
  const atRest = (x: number) => Math.abs(slidX() - x) < 1;
  // A slide is a spring: under a loaded test machine its frames come slowly.
  const settlesAt = (x: number) => vi.waitFor(() => expect(atRest(x)).toBe(true), { timeout: 5000 });

  it('follows the finger from mid-screen and blurs the focused composer', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads', <input aria-label="Message input" />);
    const input = document.querySelector('input[aria-label="Message input"]') as HTMLInputElement;
    input.focus();

    panMove(main(), [150, 220], [160, 221], [210, 224], [250, 226]);

    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(input);
      expect(main().dataset.channelDragging).toBe('true');
      // 100px of finger travel, less the few pixels it takes to recognise
      // a sideways swipe.
      expect(slidX()).toBeGreaterThan(80);
      expect(slidX()).toBeLessThanOrEqual(100);
    }, { timeout: 5000 });
    panEnd([250, 226]);
  });

  // The slide is the browser's to run — a Web Animation of the transform,
  // played on its compositor — so the page that opens can render while it
  // slides. Driven from JS frame by frame, it froze for as long as that took.
  it('slides as a Web Animation of the transform, which a busy page cannot stall', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads');
    (document.querySelector('button[aria-label="Open channels"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('true'), { timeout: 5000 });
    const sliding = main()
      .getAnimations()
      .some((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => typeof k.transform === 'string'));
    expect(sliding).toBe(true);
    await settlesAt(window.innerWidth);
  });

  it('opens the list on a long swipe', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads');
    await swipe(main(), { dx: 260, steps: 8, stepMs: 20 });
    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('true'), { timeout: 5000 });
    await settlesAt(window.innerWidth);
    expect(list()).not.toHaveAttribute('inert');
  });

  // The reported bug: a slow swipe sprang back however far it went.
  it('opens the list on a SLOW swipe that comes to rest past the commit distance', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads');
    await swipe(main(), { dx: 180, steps: 24, stepMs: 40, settle: true });
    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('true'), { timeout: 5000 });
  });

  it('slides back from a short, slow swipe', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads');
    await swipe(main(), { dx: 60, steps: 6, stepMs: 30, settle: true });
    await settlesAt(0);
    expect(main().dataset.mobileChannelsOpen).toBe('false');
    expect(main().dataset.channelDragging).toBe('false');
  });

  it('slides back when the browser takes the touch over', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads');
    await swipe(main(), { dx: 260, steps: 8, stepMs: 20, cancel: true });
    await settlesAt(0);
    expect(main().dataset.mobileChannelsOpen).toBe('false');
  });

  it('leaves a vertical drag, and a tiny wobble, to the page', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads', (
      <PageContainer title="Threads">
        <div style={{ height: 1600 }}>Scrollable thread content</div>
      </PageContainer>
    ));
    panMove(main(), [120, 400], [130, 430], [140, 460]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main().dataset.channelDragging).toBe('false');
    panEnd([140, 460]);

    panMove(main(), [100, 300], [103, 301], [106, 301]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main().dataset.channelDragging).toBe('false');
    panEnd([106, 301]);
    expect(main().dataset.mobileChannelsOpen).toBe('false');
  });

  // A right-hand panel covers the conversation: a sideways swipe there is
  // that panel's, and while one is open nothing else swipes the list in.
  it('never opens the list while a right-hand panel is open', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads', (
      <>
        <div data-testid="content" style={{ height: 100 }}>Header</div>
        <div data-mobile-right-sidebar="true" data-swipe-surface="x" data-testid="panel" style={{ height: 300 }}>
          Panel
        </div>
      </>
    ));
    for (const start of ['panel', 'content']) {
      const el = document.querySelector(`[data-testid="${start}"]`) as HTMLElement;
      const { top } = el.getBoundingClientRect();
      panMove(el, [120, top + 20], [160, top + 22], [220, top + 24]);
      await new Promise((r) => setTimeout(r, 40));
      expect(main().dataset.channelDragging).toBe('false');
      panEnd([220, top + 24]);
    }
  });

  it('slides the conversation back when the list is swiped away', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads');
    (document.querySelector('button[aria-label="Open channels"]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('true'), { timeout: 5000 });
    await settlesAt(window.innerWidth);

    // Mid-swipe the conversation comes in from the right with the finger.
    panMove(list(), [300, 300], [290, 301], [200, 304], [100, 306]);
    await vi.waitFor(() => {
      expect(main().dataset.channelDragging).toBe('true');
      expect(slidX()).toBeLessThan(window.innerWidth - 150);
    }, { timeout: 5000 });
    panEnd([100, 306]);
    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('false'), { timeout: 5000 });
    await settlesAt(0);
  });

  it('keeps the list when a swipe of it falls short', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/threads');
    (document.querySelector('button[aria-label="Open channels"]') as HTMLButtonElement).click();
    await settlesAt(window.innerWidth);

    await swipe(list(), { dx: -50, steps: 5, stepMs: 30, settle: true });
    await settlesAt(window.innerWidth);
    expect(main().dataset.mobileChannelsOpen).toBe('true');
  });

  // Home has no conversation behind the list to slide back.
  it('does not swipe the Home list away', async () => {
    if (window.innerWidth > 767) return;
    await renderAt('/');
    await swipe(list(), { dx: -260, steps: 8, stepMs: 20 });
    await new Promise((r) => setTimeout(r, 40));
    expect(main().dataset.mobileChannelsOpen).toBe('true');
    expect(atRest(window.innerWidth)).toBe(true);
  });

  // Rotating the phone changes the width the open list slides the
  // conversation by — at once, even mid-slide; a closed list keeps it in
  // place.
  it('keeps the conversation where the list leaves it across a rotation', async () => {
    if (window.innerWidth > 767) return;
    const width = window.innerWidth;
    const original = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const rotate = (w: number) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
      window.dispatchEvent(new Event('resize'));
    };
    await renderAt('/threads');
    try {
      rotate(width + 100);
      await settlesAt(0);

      // Opening slides the conversation aside; a rotation on the way ends
      // the slide at the new width.
      (document.querySelector('button[aria-label="Open channels"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('true'), { timeout: 5000 });
      rotate(width + 200);
      await settlesAt(width + 200);
    } finally {
      if (original) Object.defineProperty(window, 'innerWidth', original);
      else delete (window as { innerWidth?: number }).innerWidth;
      window.dispatchEvent(new Event('resize'));
    }
  });

  it('is not a swipe surface on desktop', async () => {
    if (window.innerWidth <= 767) return;
    await renderAt('/threads');
    expect(main()).not.toHaveAttribute('data-swipe-surface');
    panMove(main(), [120, 300], [160, 302], [220, 304]);
    await new Promise((r) => setTimeout(r, 40));
    expect(main().dataset.channelDragging).toBe('false');
    expect(main().style.transform).toBe('');
    panEnd([220, 304]);
  });
});
