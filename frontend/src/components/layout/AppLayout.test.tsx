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
    const { container } = renderLayout();

    const header = container.querySelector('header')!;
    const searchShell = screen.getByLabelText('Search').closest('header')!.querySelector('div')!;
    expect(header).toHaveClass('grid', 'w-full', 'grid-cols-[2.75rem_minmax(0,1fr)_2.75rem]');
    expect(searchShell).toHaveClass('w-full', 'max-w-2xl', 'justify-self-center', 'lg:flex-1');
  });

  it('keeps flex scroll containers shrinkable on mobile Safari', () => {
    const { container } = renderLayout();

    const bodyShell = container.querySelector('header')!.nextElementSibling as HTMLElement;
    const main = bodyShell.querySelector('main')!;
    expect(bodyShell).toHaveClass('min-h-0', 'overflow-hidden');
    expect(main).toHaveClass('min-h-0', 'overflow-hidden');
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
    expect(shell).toHaveClass('bg-[#1a1d21]');
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

    expect(pane).toHaveAttribute('aria-hidden', 'true');
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

  it('pulls the current mobile view aside while revealing channels', async () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchDrag(main, 12, 92);

    expect(screen.getByTestId('mobile-channel-sidebar')).toHaveAttribute('inert');
    await waitFor(() => expect(main).toHaveStyle({ transform: 'translate3d(80px, 0, 0)' }));
    expect(main).toHaveAttribute('data-channel-dragging', 'true');
  });

  it('keeps the covered mobile channel pane inert', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    renderLayout();

    const pane = screen.getByTestId('mobile-channel-sidebar');
    expect(pane).toHaveAttribute('aria-hidden', 'true');
    expect(pane).toHaveAttribute('inert');
  });

  it('keeps the dragged mobile channel pane inert until it is fully opened', () => {
    setMobileMatch(true);
    window.history.pushState({}, '', '/channel/general');
    const { container } = renderLayout();
    const main = container.querySelector('main')!;

    touchDrag(main, 12, 92);

    const pane = screen.getByTestId('mobile-channel-sidebar');
    expect(pane).toHaveAttribute('aria-hidden', 'true');
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
