import { describe, it, expect, vi } from 'vitest';

// MarkdownComposer pulls in roster/channel/emoji/auth/presence data hooks these
// view-level tests don't stub; they don't exercise the composer, so stub it with
// a plain textarea (matches the message-input-validation stub).
vi.mock('@/components/chat/markdown/MarkdownComposer', () => ({
  MarkdownComposer: (props: {
    ariaLabel?: string;
    placeholder?: string;
    onChange?: (md: string) => void;
    onSubmit?: (md: string) => void;
  }) => (
    <div>
      <textarea
        aria-label={props.ariaLabel ?? 'Message input'}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            props.onSubmit?.((e.target as HTMLTextAreaElement).value);
          }
        }}
        data-testid="composer-stub"
      />
      {props.placeholder ? <span>{props.placeholder}</span> : null}
    </div>
  ),
}));
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { HOME_NAV_STATE } from '@/lib/home-nav';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from '@/components/chat/ChannelView';
import type { Channel, ChannelMembership } from '@/types';

// The workspace mark on the rail navigates to ~general with HOME_NAV_STATE:
// the channel goes back to its default view, closing whatever thread or side
// panel was open, once per click.

const mockChannel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  description: '',
};

const mockMembers: ChannelMembership[] = [
  { channelID: 'ch-1', userID: 'u-1', role: 'member', displayName: 'Alice', joinedAt: '2026-01-01T00:00:00Z' },
];

vi.mock('@/context/AuthContext', () => {
  const auth = {
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
};
  return { ...auth, useOptionalAuth: auth.useAuth };
});

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set(),
    unreadChannelNotifications: new Set(),
    unreadConversations: new Set(),
    hiddenConversations: new Set(),
    markChannelUnread: vi.fn(),
    markChannelNotificationUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    hideConversation: vi.fn(),
    unhideConversation: vi.fn(),
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation: vi.fn(() => false),
    setActiveThread: vi.fn(),
    isActiveThread: vi.fn(() => false),
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

vi.mock('@/hooks/useChannels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useChannels')>()),
  useChannelBySlug: () => ({ data: mockChannel }),
  useChannelMembers: () => ({ data: mockMembers }),
  // Applies `select` like the real hook (ChannelView selects its own row).
  useUserChannels: (opts?: { select?: (rows: never[]) => unknown }) => {
    const rows = [] as never[];
    return { data: opts?.select && rows ? opts.select(rows) : rows };
  },
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
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useThreads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useThreads')>()),
  useThreadMessages: () => ({ data: [], isLoading: false }),
  useThreadFollowing: () => ({ data: false }),
  useFollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  useUnfollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  markThreadSeen: vi.fn(),
  noteThreadReadPosition: vi.fn(),
  useThreadSeenAtOpen: () => ({ known: true, seenAt: undefined }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue(undefined),
}));

function HomeButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/channel/general', { state: HOME_NAV_STATE })}>
      Go home
    </button>
  );
}

function PlainButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/channel/general')}>
      Go plain
    </button>
  );
}

function renderAt(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route
            path="/channel/:id"
            element={
              <>
                <ChannelView />
                <HomeButton />
                <PlainButton />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChannelView: the way home', () => {
  it('closes an open thread, even when this channel was already on screen', async () => {
    renderAt('/channel/general?thread=root-1#msg-root-1');
    expect(screen.getByLabelText('Close thread')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Go home'));
    await waitFor(() => expect(screen.queryByLabelText('Close thread')).not.toBeInTheDocument());
  });

  it('closes a side panel once per click; one opened afterwards stays open', async () => {
    renderAt('/channel/general');
    fireEvent.click(screen.getByLabelText('View pinned messages'));
    expect(await screen.findByLabelText('Close pinned messages')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Go home'));
    await waitFor(() => expect(screen.queryByLabelText('Close pinned messages')).not.toBeInTheDocument());

    // Still on the entry the mark made: opening a panel now must stick.
    fireEvent.click(screen.getByLabelText('View pinned messages'));
    expect(await screen.findByLabelText('Close pinned messages')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Toggle member list'));
    fireEvent.click(screen.getByLabelText('View pinned messages'));
    expect(await screen.findByLabelText('Close pinned messages')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Go home'));
    await waitFor(() => expect(screen.queryByLabelText('Close pinned messages')).not.toBeInTheDocument());
  });

  it('leaves the panels alone on any other navigation to the channel', async () => {
    renderAt('/channel/general');
    fireEvent.click(screen.getByLabelText('View pinned messages'));
    expect(await screen.findByLabelText('Close pinned messages')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Go plain'));
    expect(screen.getByLabelText('Close pinned messages')).toBeInTheDocument();
  });
});
