import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppLayout } from './AppLayout';
import { resetSidebarModeForTests, setSidebarMode } from '@/stores/sidebar-mode';
import { requestOpenChannels } from '@/lib/mobile-nav';

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
  MobileTabBar: ({ onShowList, hidden }: { onShowList: () => void; hidden?: boolean }) => (
    <nav data-testid="mobile-tab-bar" data-hidden={hidden ? 'true' : 'false'}>
      <button type="button" data-testid="mobile-tab-home" onClick={onShowList}>Home</button>
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
const root = () => document.querySelector('[data-testid="app-sidebar"]')!.parentElement as HTMLElement;

beforeEach(() => {
  resetSidebarModeForTests();
  setMobileMatch(true);
});

describe('AppLayout on a phone', () => {
  it('names the list screen and shows the tab bar, with no top bar', () => {
    renderAt('/');
    expect(screen.getByTestId('mobile-sidebar-title')).toHaveTextContent('Home');
    act(() => setSidebarMode('activity'));
    expect(screen.getByTestId('mobile-sidebar-title')).toHaveTextContent('Activity');
    expect(screen.getByTestId('mobile-tab-bar')).toHaveAttribute('data-hidden', 'false');
    expect(topBarWrapper()).toHaveClass('hidden');
    // The tab bar covers the home indicator, so surfaces above drop theirs.
    expect(root().style.getPropertyValue('--bottom-safe-inset')).toBe('0px');
  });

  it('hides the tab bar while typing', () => {
    renderAt('/');
    act(() => screen.getByLabelText('Composer').focus());
    expect(screen.getByTestId('mobile-tab-bar')).toHaveAttribute('data-hidden', 'true');
    expect(root().style.getPropertyValue('--bottom-safe-inset')).toBe('');
  });

  it('in a conversation: no tab bar or top bar; the header back button brings the list, and going somewhere closes it', () => {
    renderAt('/channel/general');
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
    expect(screen.getByTestId('mobile-tab-bar')).toHaveAttribute('data-hidden', 'true');
    expect(topBarWrapper()).toHaveClass('hidden');
    act(() => requestOpenChannels());
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'true');
    expect(screen.getByTestId('mobile-tab-bar')).toHaveAttribute('data-hidden', 'false');
    fireEvent.click(screen.getByText('go /channel/random'));
    expect(main()).toHaveAttribute('data-mobile-channels-open', 'false');
  });

  it('keeps the top bar (for its back button) on other pages, and the tab bar on Activity', () => {
    const { unmount } = renderAt('/threads');
    expect(topBarWrapper()).not.toHaveClass('hidden');
    unmount();
    renderAt('/activity');
    expect(screen.getByTestId('mobile-tab-bar')).toHaveAttribute('data-hidden', 'false');
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
