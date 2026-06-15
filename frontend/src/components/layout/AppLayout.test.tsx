import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './AppLayout';

// Mock the Sidebar to avoid pulling in all its dependencies
vi.mock('./Sidebar', () => ({
  Sidebar: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="sidebar">
      <button onClick={onClose}>Close sidebar</button>
    </div>
  ),
}));

// Mock the top bar so we don't need to wire up Auth/Theme/Presence
// providers for AppLayout's own structural assertions. The mock keeps
// the open-channels button and a search input so the existing
// mobile-shell and search-shell expectations still resolve.
vi.mock('./AppTopBar', () => ({
  AppTopBar: ({ onOpenChannels, channelsButtonHidden }: { onOpenChannels?: () => void; channelsButtonHidden?: boolean }) => (
    <header
      data-testid="app-shell-header"
      data-app-chrome="true"
      className="grid h-14 w-full shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-sidebar"
    >
      <button
        type="button"
        onClick={onOpenChannels}
        aria-label="Open channels"
        aria-hidden={channelsButtonHidden}
        tabIndex={channelsButtonHidden ? -1 : 0}
        className={channelsButtonHidden ? 'invisible' : ''}
      >
        menu
      </button>
      <div className="min-w-0 w-full max-w-xl justify-self-center mx-auto">
        <input aria-label="Search" />
      </div>
      <div>account</div>
    </header>
  ),
}));

vi.mock('@/components/UpdateBanner', () => ({
  UpdateBanner: () => <div data-testid="update-banner" />,
}));

vi.mock('@/components/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => <div data-testid="notification-permission-banner" />,
}));

function renderLayout(children: React.ReactNode = <div>Main content</div>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AppLayout>{children}</AppLayout>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

function touchSwipe(element: Element, fromX: number, toX: number, y = 200) {
  fireEvent.touchStart(element, {
    touches: [{ identifier: 1, target: element, clientX: fromX, clientY: y }],
    targetTouches: [{ identifier: 1, target: element, clientX: fromX, clientY: y }],
  });
  fireEvent.touchMove(element, {
    touches: [{ identifier: 1, target: element, clientX: toX, clientY: y + 10 }],
    targetTouches: [{ identifier: 1, target: element, clientX: toX, clientY: y + 10 }],
  });
  fireEvent.touchEnd(element, {
    changedTouches: [{ identifier: 1, target: element, clientX: toX, clientY: y + 10 }],
    targetTouches: [],
    touches: [],
  });
}

function touchSwipeWithMoves(element: Element, points: number[], y = 200) {
  const [fromX, ...moves] = points;
  fireEvent.touchStart(element, {
    touches: [{ identifier: 1, target: element, clientX: fromX, clientY: y }],
    targetTouches: [{ identifier: 1, target: element, clientX: fromX, clientY: y }],
  });
  for (const x of moves) {
    fireEvent.touchMove(element, {
      touches: [{ identifier: 1, target: element, clientX: x, clientY: y + 10 }],
      targetTouches: [{ identifier: 1, target: element, clientX: x, clientY: y + 10 }],
    });
  }
  const toX = moves.at(-1) ?? fromX;
  fireEvent.touchEnd(element, {
    changedTouches: [{ identifier: 1, target: element, clientX: toX, clientY: y + 10 }],
    targetTouches: [],
    touches: [],
  });
}

function touchDrag(element: Element, fromX: number, toX: number, y = 200) {
  fireEvent.touchStart(element, {
    touches: [{ identifier: 1, target: element, clientX: fromX, clientY: y }],
    targetTouches: [{ identifier: 1, target: element, clientX: fromX, clientY: y }],
  });
  fireEvent.touchMove(element, {
    touches: [{ identifier: 1, target: element, clientX: toX, clientY: y + 10 }],
    targetTouches: [{ identifier: 1, target: element, clientX: toX, clientY: y + 10 }],
  });
}

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe('AppLayout', () => {
  beforeEach(() => {
    delete window.Capacitor;
    setMobileMatch(false);
  });

  it('renders sidebar', () => {
    renderLayout();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  it('renders children', () => {
    renderLayout(<p>Test child content</p>);
    expect(screen.getByText('Test child content')).toBeInTheDocument();
  });

  it('renders mobile channels button', () => {
    renderLayout();
    expect(screen.getByLabelText('Open channels')).toBeInTheDocument();
  });

  it('lets the mobile top bar and search fill the full viewport width', () => {
    renderLayout();

    const header = screen.getByTestId('app-shell-header');
    const searchShell = screen.getByLabelText('Search').closest('div')!;
    expect(header).toHaveClass('w-full', 'bg-sidebar', 'border-border');
    expect(searchShell).toHaveClass('w-full', 'max-w-xl', 'justify-self-center');
  });

  it('keeps flex scroll containers shrinkable on mobile Safari', () => {
    renderLayout();

    const header = screen.getByTestId('app-shell-header');
    const bannerBlock = header.parentElement!.nextElementSibling as HTMLElement;
    const bodyShell = bannerBlock.nextElementSibling as HTMLElement;
    const main = bodyShell.querySelector('main')!;
    expect(bodyShell).toHaveClass('min-h-0', 'overflow-hidden');
    expect(main).toHaveClass('min-h-0', 'overflow-hidden');
  });

  it('renders reload and notification banners directly below the app header', () => {
    renderLayout();
    const header = screen.getByTestId('app-shell-header');
    const bannerBlock = header.parentElement!.nextElementSibling as HTMLElement;
    expect(bannerBlock).toHaveAttribute('data-testid', 'app-layout-banners');
    expect(bannerBlock).toContainElement(screen.getByTestId('update-banner'));
    expect(bannerBlock).toContainElement(screen.getByTestId('notification-permission-banner'));
    expect(bannerBlock.nextElementSibling?.querySelector('main')).toBeInTheDocument();
  });

  it('keeps the desktop sidebar as a persistent rail', () => {
    renderLayout();

    const aside = screen.getByTestId('sidebar').closest('aside')!;
    expect(aside.className).toContain('lg:block');
    expect(aside.className).not.toContain('fixed');
  });

  it('leaves top safe-area ownership to the app viewport shell', () => {
    const { container } = renderLayout();

    expect(container.querySelector('.pt-\\[env\\(safe-area-inset-top\\)\\]')).toBeNull();
    const shell = container.firstElementChild as HTMLElement;
    expect(shell).toHaveClass('bg-sidebar');
  });

  it('keeps native server switching out of the top bar', () => {
    const resetServer = vi.fn().mockResolvedValue(undefined);
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { ServerNavigation: { resetServer } },
    };

    renderLayout();

    expect(screen.queryByLabelText('Change server')).not.toBeInTheDocument();
    expect(resetServer).not.toHaveBeenCalled();
  });

  it('mobile channels button opens the persistent channel pane without navigating', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    renderLayout();

    const menuBtn = screen.getByLabelText('Open channels');
    fireEvent.click(menuBtn);

    expect(window.location.pathname).toBe('/channel/general');
    expect(screen.getByTestId('mobile-channel-sidebar')).not.toHaveAttribute('inert');
    expect(screen.getByTestId('mobile-channel-sidebar')).not.toHaveAttribute('aria-hidden');
    expect(document.querySelector('main')).toHaveAttribute('data-mobile-channels-open', 'true');
  });

  it('closes the persistent mobile channel pane from a sidebar selection', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    renderLayout();

    fireEvent.click(screen.getByLabelText('Open channels'));
    const pane = screen.getByTestId('mobile-channel-sidebar');
    fireEvent.click(within(pane).getByText('Close sidebar'));

    expect(pane).not.toHaveAttribute('aria-hidden');
    expect(pane).toHaveAttribute('inert');
    expect(document.querySelector('main')).toHaveAttribute('data-mobile-channels-open', 'false');
  });

  it('can reveal the mobile channel pane again after it was closed', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;
    const pane = screen.getByTestId('mobile-channel-sidebar');

    touchSwipe(main, 12, 120);
    expect(main).toHaveAttribute('data-mobile-channels-open', 'true');
    fireEvent.click(within(pane).getByText('Close sidebar'));
    expect(main).toHaveAttribute('data-mobile-channels-open', 'false');

    touchSwipe(main, 12, 120);

    expect(main).toHaveAttribute('data-mobile-channels-open', 'true');
    expect(pane).not.toHaveAttribute('inert');
  });

  it('can reveal the mobile channel pane again after releasing near the end', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;
    const pane = screen.getByTestId('mobile-channel-sidebar');

    touchSwipeWithMoves(main, [12, 260, 340]);
    expect(main).toHaveAttribute('data-mobile-channels-open', 'true');
    fireEvent.click(within(pane).getByText('Close sidebar'));
    expect(main).toHaveAttribute('data-mobile-channels-open', 'false');

    touchSwipe(main, 12, 120);

    expect(main).toHaveAttribute('data-mobile-channels-open', 'true');
    expect(pane).not.toHaveAttribute('inert');
  });

  it('treats the mobile root route as the channel list surface', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/');
    const { container } = renderLayout();

    const menuBtn = screen.getByLabelText('Open channels');
    expect(menuBtn).toHaveClass('invisible');
    expect(menuBtn).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('mobile-channel-sidebar')).not.toHaveAttribute('inert');
    expect(container.querySelector('main')).toHaveAttribute('data-mobile-channels-open', 'true');
  });

  it('ignores channel reveal swipes from the mobile root route', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchSwipe(main, 12, 120);

    expect(main).toHaveAttribute('data-mobile-channels-open', 'true');
  });

  it('ignores channel-open swipes entirely on a desktop (non-mobile) layout', () => {
    setMobileMatch(false);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;
    // On desktop the swipe handler bails immediately (!isMobile).
    touchSwipe(main, 12, 160);
    expect(main).not.toHaveAttribute('data-channel-dragging', 'true');
  });

  it('closes the open channel pane on a right-to-left swipe', () => {
    setMobileMatch(true);
    // The mobile root route renders with channels already open, so a
    // leftward swipe commits to the "close" latch.
    window.history.pushState({}, '', '/');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;
    expect(main).toHaveAttribute('data-mobile-channels-open', 'true');
    touchSwipe(main, 220, 40);
    expect(main).toHaveAttribute('data-channel-dragging', 'true');
  });

  it('opens the persistent mobile channel pane on a left-to-right touch swipe', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchSwipe(main, 12, 120);

    expect(main).toHaveAttribute('data-channel-dragging', 'true');
    expect(main).toHaveAttribute('data-mobile-channels-open', 'true');
    expect(window.location.pathname).toBe('/channel/general');
  });

  it('refuses to open channels when a mobile right sidebar is mounted anywhere', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout(
      <div data-testid="rs" data-mobile-right-sidebar="true">Right panel</div>,
    );
    const main = container.querySelector('main')!;

    // Swiping on main: the gesture target is not the right sidebar (so the
    // closest() guard passes), but the document-wide right-sidebar query trips
    // canOpenChannelsFromGesture, so the pane must not open.
    touchSwipe(main, 12, 120);
    expect(main).not.toHaveAttribute('data-mobile-channels-open', 'true');
  });

  it('refuses to open channels when the swipe starts on the mobile right sidebar', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout(
      <div data-testid="rs" data-mobile-right-sidebar="true">Right panel</div>,
    );
    const main = container.querySelector('main')!;
    const rightSidebar = screen.getByTestId('rs');

    // Swiping from within the right sidebar hits the closest() guard directly.
    touchSwipe(rightSidebar, 12, 120);
    expect(main).not.toHaveAttribute('data-mobile-channels-open', 'true');
  });

  it('still tracks a latched swipe when the touchmove event is not cancelable', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    // A non-cancelable touchmove latches the gesture but skips the
    // event.preventDefault() branch (event.cancelable === false).
    fireEvent.touchStart(main, {
      touches: [{ identifier: 1, target: main, clientX: 12, clientY: 200 }],
      targetTouches: [{ identifier: 1, target: main, clientX: 12, clientY: 200 }],
    });
    fireEvent.touchMove(main, {
      cancelable: false,
      touches: [{ identifier: 1, target: main, clientX: 120, clientY: 210 }],
      targetTouches: [{ identifier: 1, target: main, clientX: 120, clientY: 210 }],
    });
    expect(main).toHaveAttribute('data-channel-dragging', 'true');
    fireEvent.touchEnd(main, {
      changedTouches: [{ identifier: 1, target: main, clientX: 120, clientY: 210 }],
      targetTouches: [],
      touches: [],
    });
  });

  it('ignores a sub-threshold horizontal nudge (below the axis lock)', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    // 6px of horizontal movement is below CHANNEL_OPEN_AXIS_LOCK_PX (12),
    // so the gesture never latches and the pane stays closed.
    touchSwipe(main, 12, 18);
    expect(main).not.toHaveAttribute('data-mobile-channels-open', 'true');
  });

  it('lets a vertical-dominant drag fall through to native scroll', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    // Large vertical movement with smaller horizontal travel → absY >= absX,
    // so the channel-open gesture yields to native scrolling.
    fireEvent.touchStart(main, {
      touches: [{ identifier: 1, target: main, clientX: 12, clientY: 200 }],
      targetTouches: [{ identifier: 1, target: main, clientX: 12, clientY: 200 }],
    });
    fireEvent.touchMove(main, {
      touches: [{ identifier: 1, target: main, clientX: 30, clientY: 320 }],
      targetTouches: [{ identifier: 1, target: main, clientX: 30, clientY: 320 }],
    });
    fireEvent.touchEnd(main, {
      changedTouches: [{ identifier: 1, target: main, clientX: 30, clientY: 320 }],
      targetTouches: [],
      touches: [],
    });
    expect(main).not.toHaveAttribute('data-mobile-channels-open', 'true');
  });

  it('pulls the current mobile view aside while revealing channels', async () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchDrag(main, 12, 92);

    expect(screen.getByTestId('mobile-channel-sidebar')).toHaveAttribute('inert');
    // @use-gesture subtracts its hold-threshold from the reported
    // movement, so an 80px finger drag exposes ~72px of translation.
    // Match either form so the test stays robust if the threshold is
    // re-tuned.
    await waitFor(() => {
      const transform = (main as HTMLElement).style.transform;
      expect(transform).toMatch(/translate3d\(calc\(0px \+ \d+px\),\s*0,\s*0\)/);
      expect(transform).not.toBe('translate3d(0px, 0, 0)');
    });
    expect(main).toHaveAttribute('data-channel-dragging', 'true');
  });

  it('blurs the focused mobile composer when a channel-sidebar swipe starts', async () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout(<input aria-label="Message input" />);
    const input = screen.getByLabelText('Message input');
    const main = container.querySelector('main')!;

    input.focus();
    expect(document.activeElement).toBe(input);

    touchDrag(main, 12, 92);

    await waitFor(() => expect(document.activeElement).not.toBe(input));
    expect(main).toHaveAttribute('data-channel-dragging', 'true');
  });

  it('requires a distinct left-edge swipe before moving the mobile chat view', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchDrag(main, 96, 176);

    expect(main).toHaveAttribute('data-channel-dragging', 'false');
    expect(main).not.toHaveStyle({ transform: 'translate3d(80px, 0, 0)' });
    expect(screen.getByTestId('mobile-channel-sidebar')).toHaveAttribute('inert');
  });

  it('keeps the covered mobile channel pane inert', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    renderLayout();

    const pane = screen.getByTestId('mobile-channel-sidebar');
    expect(pane).not.toHaveAttribute('aria-hidden');
    expect(pane).toHaveAttribute('inert');
  });

  it('keeps the dragged mobile channel pane inert until it is fully opened', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchDrag(main, 12, 92);

    const pane = screen.getByTestId('mobile-channel-sidebar');
    expect(pane).not.toHaveAttribute('aria-hidden');
    expect(pane).toHaveAttribute('inert');
  });

  it('does not reveal channels on swipe while a right sidebar is open', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout(<div data-mobile-right-sidebar="true">Thread</div>);
    const main = container.querySelector('main')!;

    touchSwipe(main, 12, 120);

    expect(window.location.pathname).toBe('/channel/general');
  });

  it('settles the mobile view back when the channel swipe is too short', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchSwipe(main, 12, 50);

    expect(main).toHaveAttribute('data-mobile-channels-open', 'false');
    expect(screen.getByTestId('mobile-channel-sidebar')).toHaveAttribute('inert');
  });

  it('does not reveal channels on a right-to-left touch swipe', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchSwipe(main, 120, 12);

    expect(main).toHaveAttribute('data-mobile-channels-open', 'false');
    expect(window.location.pathname).toBe('/channel/general');
  });

  it('does not reveal channels when the swipe starts inside a right sidebar', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout(<div data-mobile-right-sidebar="true">Thread</div>);
    const sidebar = screen.getByText('Thread');

    touchSwipe(sidebar, 12, 120);

    expect(window.location.pathname).toBe('/channel/general');
    expect(container.querySelector('[data-mobile-right-sidebar="true"]')).toBeInTheDocument();
  });

  it('ignores desktop mouse drags for mobile channel swipe navigation', () => {
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    fireEvent.mouseDown(main, { clientX: 12, clientY: 200 });
    fireEvent.mouseUp(main, { clientX: 120, clientY: 210 });

    expect(window.location.pathname).toBe('/channel/general');
  });

  it('does not render a mobile side-over overlay', () => {
    const { container } = renderLayout();

    expect(container.querySelector('.bg-black\\/50')).toBeNull();
  });
});
