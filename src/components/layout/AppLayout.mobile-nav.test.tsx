import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './AppLayout';
import { resetSidebarModeSessionState, setSidebarMode } from '@/stores/sidebar-mode';
import { requestOpenChannels } from '@/lib/mobile-nav';
import { resetMobileBackCloseForTests } from '@/hooks/useMobileBackClose';

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
vi.mock('@/components/activity/ActivityModeSwitch', () => ({
  ActivityModeSwitch: () => <div data-testid="sidebar-mode-switch" />,
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


function GoTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(to)}>
      go {to}
    </button>
  );
}

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AppLayout>
          <input aria-label="Composer" />
          <GoTo to="/channel/random" />
          <GoTo to="/channel/general?thread=root-1#msg-m-1" />
          <GoTo to="/" />
        </AppLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
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

const topBarWrapper = () => screen.getByTestId('app-shell-header').parentElement!;
const main = () => document.querySelector('[data-app-main="true"]')!;
const list = () => screen.getByTestId('mobile-channel-sidebar');
const tabBar = () => screen.getByTestId('mobile-tab-bar');

beforeEach(() => {
  resetSidebarModeSessionState();
  setMobileMatch(true);
});

describe('AppLayout on a phone', () => {
  it('names the list screen and shows the tab bar, with no top bar', () => {
    renderAt('/');
    expect(screen.getByTestId('mobile-sidebar-title')).toHaveTextContent('Home');
    act(() => setSidebarMode('activity'));
    expect(screen.getByTestId('mobile-sidebar-title')).toHaveTextContent('Activity');
    expect(tabBar()).toHaveAttribute('data-hidden', 'false');
    expect(topBarWrapper()).toHaveClass('hidden');
    // The tab bar is the foot of the list screen, and covers the home
    // indicator, so the list above it drops its own inset.
    expect(list()).toContainElement(tabBar());
    expect(list().style.getPropertyValue('--bottom-safe-inset')).toBe('0px');
  });

  it('hides the tab bar while typing', () => {
    renderAt('/');
    act(() => screen.getByLabelText('Composer').focus());
    expect(tabBar()).toHaveAttribute('data-hidden', 'true');
    expect(list().style.getPropertyValue('--bottom-safe-inset')).toBe('');
  });

  it('in a conversation: the list and its tab bar lie under it, no top bar; the header back button brings the list, and going somewhere closes it', () => {
    renderAt('/channel/general');
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
    expect(list()).toHaveAttribute('inert');
    expect(list()).toContainElement(tabBar());
    expect(topBarWrapper()).toHaveClass('hidden');
    act(() => requestOpenChannels());
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'true');
    expect(list()).not.toHaveAttribute('inert');
    expect(tabBar()).toHaveAttribute('data-hidden', 'false');
    fireEvent.click(screen.getByText('go /channel/random'));
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
  });

  it('keeps the top bar (for its back button) on other pages', () => {
    renderAt('/threads');
    expect(topBarWrapper()).not.toHaveClass('hidden');
    expect(list()).toHaveAttribute('inert');
  });

  // Picking a chat on the home list slides it in right away: the page it
  // opens renders under the slide instead of holding it back.
  it('a pick from the home list makes way at once, and home shows the list again later', () => {
    renderAt('/');
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'true');
    fireEvent.click(within(list()).getByText('Close sidebar'));
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
    // No top bar flashes in while the page it opens is still on its way.
    expect(topBarWrapper()).toHaveClass('hidden');
    fireEvent.click(screen.getByText('go /channel/random'));
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
    fireEvent.click(screen.getByText('go /'));
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'true');
  });

  // A pick from the search sheet inside the conversation already open behind
  // the list (same path, new ?thread=/#msg-) used to land under the drawer.
  it('closes the list for a navigation that stays on the same page', () => {
    renderAt('/channel/general');
    act(() => requestOpenChannels());
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'true');
    fireEvent.click(screen.getByText('go /channel/general?thread=root-1#msg-m-1'));
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
  });

  // The tab bar is part of the list screen: a conversation covers it, so it
  // only ever switches a list that is already on screen — a tab tap never
  // opens the drawer or arms a Back-to-close.
  it('keeps the tab bar on the list screen, under a conversation', () => {
    const before = window.history.length;
    const { unmount } = renderAt('/');
    expect(tabBar()).toHaveAttribute('data-hidden', 'false');
    fireEvent.click(screen.getByTestId('mobile-tab-home'));
    expect(window.history.length).toBe(before);
    unmount();
    renderAt('/channel/general');
    expect(list()).toHaveAttribute('inert');
    act(() => requestOpenChannels());
    expect(list()).not.toHaveAttribute('inert');
    expect(tabBar()).toHaveAttribute('data-hidden', 'false');
  });

  // Android's Back (or the browser's) closes a list brought up over the
  // conversation instead of leaving the page.
  it('Back closes a list opened over the conversation', async () => {
    // Earlier tests' closes queue history traversals of their own.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    resetMobileBackCloseForTests();
    renderAt('/channel/general');
    act(() => requestOpenChannels());
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'true');
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
  });

  it('navigating with the list closed leaves it closed', () => {
    renderAt('/channel/general');
    fireEvent.click(screen.getByText('go /channel/random'));
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
  });
});

describe('AppLayout on desktop', () => {
  it('renders no tab bar and keeps the top bar', () => {
    setMobileMatch(false);
    renderAt('/channel/general');
    expect(screen.queryByTestId('mobile-tab-bar')).not.toBeInTheDocument();
    expect(topBarWrapper()).not.toHaveClass('hidden');
  });
});
