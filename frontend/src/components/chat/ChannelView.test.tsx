import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from './ChannelView';
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
};

const mockMembers: ChannelMembership[] = [
  { channelID: 'ch-1', userID: 'u-1', role: 'owner', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
  { channelID: 'ch-1', userID: 'u-2', role: 'member', displayName: 'Bob', joinedAt: '2026-01-01T00:00:00Z' },
];

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
    markChannelUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
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
  useChannelMembers: () => ({ data: mockMembers }),
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
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
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

describe('ChannelView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders channel name in header', () => {
    renderChannelView();
    expect(screen.getByRole('heading', { name: 'general' })).toBeInTheDocument();
  });

  it('renders message input with channel placeholder', () => {
    renderChannelView();
    // The WysiwygEditor exposes its placeholder as `data-placeholder` on
    // the contentEditable surface (no native placeholder attribute).
    expect(
      screen.getByLabelText('Message input').getAttribute('data-placeholder'),
    ).toBe('Write to #general');
  });

  it('shows "No messages yet" when there are no messages', () => {
    renderChannelView();
    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it('renders member count badge', () => {
    renderChannelView();
    // members has 2 entries
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders public channel icon', () => {
    renderChannelView();
    expect(screen.getByLabelText('Public channel')).toBeInTheDocument();
  });

  it('toggles the pinned messages sidebar when the header pin button is clicked', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const u = userEvent.setup();
    renderChannelView();
    expect(screen.queryByLabelText('Pinned messages')).toBeNull();
    await u.click(screen.getByTestId('pinned-toggle'));
    expect(screen.getByLabelText('Pinned messages')).toBeInTheDocument();
    await u.click(screen.getByTestId('pinned-toggle'));
    expect(screen.queryByLabelText('Pinned messages')).toBeNull();
  });
});
