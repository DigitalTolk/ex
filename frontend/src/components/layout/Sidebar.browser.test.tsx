import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Sidebar } from './Sidebar';
import type { User, UserChannel } from '@/types';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

const mockUser: User = {
  id: 'u-1',
  email: 'alice@test.com',
  displayName: 'Alice Smith',
  systemRole: 'admin',
  status: 'active',
};

const mockChannels: UserChannel[] = Array.from({ length: 50 }, (_, index) => ({
  channelID: `ch-${index}`,
  channelName: `channel-${index}`,
  channelType: 'public',
  role: 1,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set<string>(),
    unreadConversations: new Set<string>(),
    unreadThreadNotifications: new Set<string>(),
    hiddenConversations: new Set<string>(),
    hideConversation: vi.fn(),
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>() }),
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: mockChannels }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: [] }),
}));

vi.mock('@/hooks/useThreads', () => ({
  THREAD_SEEN_CHANGED_EVENT: 'ex:thread-seen-changed',
  getSeenMap: () => ({}),
  unreadThreadIDs: () => new Set<string>(),
  useUserThreads: () => ({ data: [] }),
}));

vi.mock('@/hooks/useUserState', () => ({
  useUserState: () => ({ data: { hiddenConversations: [], channelNotifications: [], threadNotifications: [] } }),
}));

vi.mock('@/hooks/useDrafts', () => ({
  useDrafts: () => ({ data: [] }),
}));

vi.mock('@/hooks/useUsersBatch', () => ({
  useUsersBatch: () => ({ map: new Map() }),
}));

vi.mock('@/hooks/useSidebar', () => ({
  useCategories: () => ({ data: [] }),
  useCreateCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useFavoriteChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useFavoriteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSetCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useSetConversationCategory: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderCategories: () => ({ mutate: vi.fn(), isPending: false }),
}));

function SidebarHarness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <style>
          {`
            .browser-sidebar-frame > div {
              display: flex;
              height: 100%;
              width: 100%;
              min-width: 0;
              flex-direction: column;
            }
            .browser-sidebar-frame [data-slot="scroll-area"] {
              min-height: 0;
              flex: 1 1 0%;
              width: 100%;
            }
            .browser-sidebar-frame [data-slot="scroll-area-viewport"] {
              height: 100%;
              overflow-y: auto;
            }
          `}
        </style>
        <div
          className="browser-sidebar-frame"
          style={{ height: 320, width: Math.min(window.innerWidth, 360), background: '#1a1d21', overflow: 'hidden' }}
        >
          <Sidebar onClose={vi.fn()} />
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

describe('Sidebar browser behavior', () => {
  it('scrolls the channel list in a real browser viewport', async () => {
    const screen = await render(<SidebarHarness />);
    await expect.element(screen.getByText('channel-0')).toBeVisible();

    const viewport = document.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);

    viewport!.scrollTop = viewport!.scrollHeight;
    viewport!.dispatchEvent(new Event('scroll', { bubbles: true }));

    await vi.waitFor(() => {
      expect(viewport!.scrollTop).toBeGreaterThan(0);
    });
    const lowerChannel = screen.getByText('channel-9');
    await expect.element(lowerChannel).toBeVisible();
    expectPaintedAtCenter(lowerChannel.element());
  });

  it('runs under the configured desktop and mobile browser sizes', () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    expect([
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
      { width: 393, height: 852 },
    ]).toContainEqual(viewport);
  });
});
