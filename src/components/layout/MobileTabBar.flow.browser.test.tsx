import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppLayout } from './AppLayout';
import { apiFetch } from '@/lib/api';
import { requestOpenChannels } from '@/lib/mobile-nav';
import { resetSidebarModeSessionState } from '@/stores/sidebar-mode';

// The phone's list screens end to end: the real layout, tab bar, search sheet
// and Activity list — only the network, the channel list and the search field
// (its own suites) are stood in. Runs on the phone instances.

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), apiFetch: vi.fn() }));
vi.mock('./Sidebar', () => ({ Sidebar: () => <nav data-testid="channel-list">channels</nav> }));
vi.mock('./AccountMenu', () => ({ AccountMenu: () => <button type="button">You</button> }));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));
vi.mock('@/components/UpdateBanner', () => ({ UpdateBanner: () => null }));
vi.mock('./LoadingBar', () => ({ LoadingBar: () => null }));
// SearchBar's contract with the sheet: a result is a link, and opening one
// calls onDone.
vi.mock('@/components/SearchBar', () => ({
  SearchBar: ({ onDone }: { onDone?: () => void }) => (
    <Link to="/channel/general?thread=root-1#msg-m-1" onClick={onDone} data-testid="search-result">
      a result
    </Link>
  ),
}));

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

// Both phone projects (chromium-mobile and webkit-iphone) pin the touch tier
// at phone width — key on that, not on navigator.maxTouchPoints, which another
// file's CDP touch emulation can flip mid-run and made these tests run or skip
// depending on file order.
const isPhone = () => window.__EX_FORCE_DEVICE__ === 'touch' && window.innerWidth < 768;
const main = () => document.querySelector<HTMLElement>('[data-app-main="true"]')!;
const tabBar = () => document.querySelector<HTMLElement>('[data-testid="mobile-tab-bar"]')!;
const sheet = () => document.querySelector('[data-testid="mobile-search-panel"]');

let active: { unmount: () => Promise<void> } | null = null;

async function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = await render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppLayout>
            <div data-testid="page">page</div>
          </AppLayout>
          <Where />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  active = result;
  return result;
}

describe('phone list screens', () => {
  beforeEach(() => {
    resetSidebarModeSessionState();
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/v1/activity') {
        return {
          items: [{ id: 'a', type: 'mention', createdAt: new Date().toISOString(), messageID: 'm-a', parentID: 'ch-1', parentType: 'channel', read: false, messagePreview: 'standup moved' }],
          unread: 1,
          unreadByType: { mention: 1 },
        };
      }
      return [];
    });
  });
  afterEach(async () => {
    if (active) await active.unmount();
    active = null;
  });

  it('switches the list between Home and Activity from the tab bar, without touching history', async () => {
    if (!isPhone()) return;
    const screen = await renderAt('/');
    const before = window.history.length;
    await expect.element(screen.getByTestId('channel-list')).toBeVisible();
    await expect.element(screen.getByTestId('mobile-tab-unread')).toHaveTextContent('1');
    await screen.getByRole('button', { name: 'Activity, 1 unread' }).click();
    await expect.element(screen.getByTestId('mobile-sidebar-title')).toHaveTextContent('Activity');
    await expect.element(screen.getByText('standup moved')).toBeVisible();
    await screen.getByRole('button', { name: 'Home' }).click();
    await expect.element(screen.getByTestId('mobile-sidebar-title')).toHaveTextContent('Home');
    expect(window.history.length).toBe(before);
  });

  it('opens a search result from the sheet: the sheet and the list both make way for it', async () => {
    if (!isPhone()) return;
    const screen = await renderAt('/');
    await screen.getByRole('button', { name: 'Search' }).click();
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    // The result in the sheet — the top bar keeps its own (hidden) search on phones.
    await screen.getByTestId('mobile-search-panel').getByTestId('search-result').click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/general?thread=root-1');
    await vi.waitFor(() => expect(sheet()).toBeNull());
    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('false'));
    expect(tabBar()).toHaveClass('hidden');
  });

  // The list brought up over the open conversation (its header's back
  // button) must also make way for a result in that same conversation.
  it('closes the list for a result in the conversation already open behind it', async () => {
    if (!isPhone()) return;
    const screen = await renderAt('/channel/general');
    requestOpenChannels();
    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('true'));
    await screen.getByRole('button', { name: 'Search' }).click();
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    // The result in the sheet — the top bar keeps its own (hidden) search on phones.
    await screen.getByTestId('mobile-search-panel').getByTestId('search-result').click();
    await expect.element(screen.getByTestId('where')).toHaveTextContent('/channel/general?thread=root-1');
    await vi.waitFor(() => expect(main().dataset.mobileChannelsOpen).toBe('false'));
  });
});
