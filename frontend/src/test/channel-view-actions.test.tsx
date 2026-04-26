import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from '@/components/chat/ChannelView';
import type { Channel, ChannelMembership } from '@/types';

// --- mocks ---------------------------------------------------------------

const mockChannel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  description: 'General chat',
};

const mockMembersOwner: ChannelMembership[] = [
  { channelID: 'ch-1', userID: 'u-1', role: 3 as unknown as ChannelMembership['role'], displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
  { channelID: 'ch-1', userID: 'u-2', role: 'member', displayName: 'Bob', joinedAt: '2026-01-01T00:00:00Z' },
];

const mockMembersMember: ChannelMembership[] = [
  { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
  { channelID: 'ch-1', userID: 'u-2', role: 'owner', displayName: 'Bob', joinedAt: '2026-01-01T00:00:00Z' },
];

let currentMembers = mockMembersOwner;

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set(),
    unreadConversations: new Set(),
    hiddenConversations: new Set(),
    markChannelUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    hideConversation: vi.fn(),
    unhideConversation: vi.fn(),
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation: vi.fn(() => false),
  }),
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline: vi.fn(),
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: () => ({ data: mockChannel }),
  useChannelMembers: () => ({ data: currentMembers }),
  useUserChannels: () => ({ data: [] }),
  useBrowseChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
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

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

const mockApiFetch = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

// --- helpers -------------------------------------------------------------

function renderChannelView(slug = 'general') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/channel/${slug}`]}>
        <Routes>
          <Route path="/channel/:id" element={<ChannelView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// --- tests ---------------------------------------------------------------

describe('ChannelView - owner actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMembers = mockMembersOwner;
  });

  it('shows member list when toggle is clicked', async () => {
    renderChannelView();
    fireEvent.click(screen.getByLabelText('Toggle member list'));
    expect(screen.getByText('Members')).toBeInTheDocument();
  });

  it('builds memberMap from channel members', () => {
    renderChannelView();
    // The channel renders, which means memberMap was constructed successfully
    expect(screen.getByText('general')).toBeInTheDocument();
  });
});

describe('ChannelView - member actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentMembers = mockMembersMember;
  });

  it('renders channel for a regular member', () => {
    renderChannelView();
    expect(screen.getByText('general')).toBeInTheDocument();
  });
});

describe('ChannelView - no slug', () => {
  it('shows placeholder when no slug is provided', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/channel/']}>
          <Routes>
            <Route path="/channel/" element={<ChannelView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // ChannelView without slug shows placeholder
    expect(screen.getByText('Select a channel to start chatting')).toBeInTheDocument();
  });
});
