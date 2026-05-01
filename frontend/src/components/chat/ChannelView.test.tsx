import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

  it('renders message input with channel placeholder', async () => {
    renderChannelView();
    // Lexical renders the placeholder as a sibling element of the
    // contenteditable when the doc is empty.
    await waitFor(() => {
      expect(screen.getByText('Write to ~general')).toBeInTheDocument();
    });
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

  it('typing indicator renders between the message list and the message input (not under the input)', () => {
    // Regression: TypingIndicator was `absolute bottom-0` of its
    // nearest positioned ancestor. That ancestor was MessageDropZone,
    // which wraps the MessageInput too — so the indicator anchored to
    // the dropzone's bottom edge, *below* the input. The fix puts it
    // in normal flow as a sibling of MessageList, sitting naturally
    // above the input.
    //
    // Earlier attempts to wrap MessageList + indicator in their own
    // `relative` flex-1 container broke MessageList's overflow scroll
    // (DMs stopped scrolling, channels drifted on send), so we keep
    // the surrounding DOM flat and just rely on DOM order.
    const { container } = renderChannelView();
    const dropzone = container.querySelector('div.flex.flex-1.flex-col.min-h-0');
    expect(dropzone).not.toBeNull();
    const children = Array.from(dropzone!.children);
    const inputIdx = children.findIndex((c) =>
      c.querySelector('[aria-label="Message input"]'),
    );
    const messagesIdx = children.findIndex((c) => c.classList.contains('overflow-y-auto'));
    expect(messagesIdx).toBeGreaterThanOrEqual(0);
    expect(inputIdx).toBeGreaterThan(messagesIdx);
    // No nested `relative flex-1 flex-col min-h-0` wrapper between
    // MessageList and the dropzone — that one broke scroll heights.
    const messages = children[messagesIdx] as HTMLElement;
    expect(messages.parentElement).toBe(dropzone);
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
