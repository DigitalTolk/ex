import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from '@/components/chat/ChannelView';
import type { Channel, ChannelMembership } from '@/types';

const mockChannel: Channel = {
  id: 'ch-1',
  name: 'random',
  slug: 'random',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
};

let mockMembersData: ChannelMembership[] = [];

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-current', displayName: 'Me', email: 'me@x.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    clearChannelUnread: vi.fn(),
    setActiveChannel: vi.fn(),
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false, setUserOnline: vi.fn() }),
}));

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: () => ({ data: mockChannel }),
  useChannelMembers: () => ({ data: mockMembersData }),
  useUserChannels: () => ({ data: [] }),
  useMuteChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useMessages', () => ({
  useChannelMessages: () => ({
    data: { pages: [{ items: [] }] },
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
  }),
  useSendChannelMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

function renderAt(slug: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/channel/${slug}`]}>
        <Routes>
          <Route path="/channel/:id" element={<ChannelView />} />
          <Route path="/" element={<div data-testid="home">Select a channel</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChannelView redirect on removed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders normally when current user is in the members list', () => {
    mockMembersData = [
      { channelID: 'ch-1', userID: 'u-current', role: 'member', displayName: 'Me', joinedAt: '2026-01-01' },
      { channelID: 'ch-1', userID: 'u-other', role: 'member', displayName: 'Other', joinedAt: '2026-01-01' },
    ];
    renderAt('random');
    expect(screen.queryByTestId('home')).toBeNull();
  });

  it('navigates home when members list no longer contains the current user', async () => {
    mockMembersData = [
      { channelID: 'ch-1', userID: 'u-other', role: 'member', displayName: 'Other', joinedAt: '2026-01-01' },
    ];
    renderAt('random');
    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeInTheDocument();
    });
  });

  it('does not navigate while members is still empty (initial loading state)', () => {
    mockMembersData = [];
    renderAt('random');
    // Empty list is treated as "still loading" — don't fire a redirect.
    expect(screen.queryByTestId('home')).toBeNull();
  });
});
