import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './AppLayout';

// The compact tier: a fine-pointer device below 1024px gets desktop chrome
// with a TOGGLEABLE overlay sidebar — not the mobile drawer, and (the
// pre-tier bug) not a hamburger that opens nothing.

vi.mock('./Sidebar', () => ({
  Sidebar: ({ onClose }: { onClose: () => void }) => (
    <nav data-testid="sidebar-body">
      <button type="button" data-testid="sidebar-nav-item" onClick={onClose}>
        general
      </button>
    </nav>
  ),
}));
vi.mock('./AppTopBar', () => ({
  AppTopBar: ({ onOpenChannels, channelsButtonHidden }: { onOpenChannels?: () => void; channelsButtonHidden?: boolean }) => (
    <header data-testid="app-shell-header">
      <button
        type="button"
        aria-label="Open channels"
        onClick={onOpenChannels}
        className={channelsButtonHidden ? 'invisible' : ''}
      >
        menu
      </button>
    </header>
  ),
}));
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));

const originalInnerWidth = window.innerWidth;

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  // Keep the width-media-query in lockstep with innerWidth for useIsMobile.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === '(max-width: 767px)' ? width < 768 : false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

function renderLayout() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/channel/general']}>
        <AppLayout>
          <div data-testid="page-main">main</div>
        </AppLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AppLayout compact tier (fine-pointer, narrow window)', () => {
  beforeEach(() => {
    window.__EX_FORCE_DEVICE__ = 'desktop';
  });

  afterEach(() => {
    window.__EX_FORCE_DEVICE__ = 'touch'; // jsdom default from setup
    setViewportWidth(originalInnerWidth);
  });

  it('a 700px desktop window is compact: toggle opens the overlay sidebar, not the mobile drawer', () => {
    setViewportWidth(700);
    renderLayout();

    // No mobile drawer (that's the touch tier)…
    expect(screen.queryByTestId('mobile-channel-sidebar')).toBeNull();
    // …and nothing open until toggled.
    expect(screen.queryByTestId('compact-sidebar')).toBeNull();

    fireEvent.click(screen.getByLabelText('Open channels'));
    expect(screen.getByTestId('compact-sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('compact-sidebar-backdrop')).toBeInTheDocument();

    // The toggle closes it again.
    fireEvent.click(screen.getByLabelText('Open channels'));
    expect(screen.queryByTestId('compact-sidebar')).toBeNull();
  });

  it('the 768-1023 tablet band gets the same working toggle (the band used to open nothing)', () => {
    setViewportWidth(900);
    renderLayout();
    fireEvent.click(screen.getByLabelText('Open channels'));
    expect(screen.getByTestId('compact-sidebar')).toBeInTheDocument();
  });

  it('backdrop click, Escape, and sidebar navigation each dismiss the overlay', () => {
    setViewportWidth(700);
    renderLayout();
    const open = () => fireEvent.click(screen.getByLabelText('Open channels'));

    open();
    fireEvent.click(screen.getByTestId('compact-sidebar-backdrop'));
    expect(screen.queryByTestId('compact-sidebar')).toBeNull();

    open();
    // Unrelated keys leave it open; Escape closes.
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByTestId('compact-sidebar')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('compact-sidebar')).toBeNull();

    open();
    // Scope to the overlay: the (CSS-hidden) persistent sidebar also mounts
    // its nav in jsdom, where classes don't hide anything.
    fireEvent.click(within(screen.getByTestId('compact-sidebar')).getByTestId('sidebar-nav-item'));
    expect(screen.queryByTestId('compact-sidebar')).toBeNull();

    // The persistent (lg+) aside wires a noop close — clicking its nav must
    // not throw or resurrect any overlay.
    fireEvent.click(within(screen.getByTestId('app-sidebar')).getByTestId('sidebar-nav-item'));
    expect(screen.queryByTestId('compact-sidebar')).toBeNull();
  });

  it('growing back to a full-width window closes the overlay', () => {
    setViewportWidth(700);
    renderLayout();
    fireEvent.click(screen.getByLabelText('Open channels'));
    expect(screen.getByTestId('compact-sidebar')).toBeInTheDocument();

    setViewportWidth(1280);
    expect(screen.queryByTestId('compact-sidebar')).toBeNull();
  });

  it('a 700px TOUCH viewport still uses the mobile drawer, untouched', () => {
    window.__EX_FORCE_DEVICE__ = 'touch';
    setViewportWidth(700);
    renderLayout();
    expect(screen.getByTestId('mobile-channel-sidebar')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Open channels'));
    expect(screen.queryByTestId('compact-sidebar')).toBeNull();
  });
});
