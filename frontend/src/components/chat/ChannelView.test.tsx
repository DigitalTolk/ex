import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from './ChannelView';
import type { Channel, ChannelMembership } from '@/types';
import { ApiError, apiFetch } from '@/lib/api';

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

let channelQuery: { data?: Channel; error?: Error; isLoading?: boolean };

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
    unreadChannelNotifications: new Set(),
    unreadConversations: new Set(),
    markChannelUnread: vi.fn(),
    markChannelNotificationUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
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

vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: () => channelQuery,
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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    apiFetch: vi.fn().mockResolvedValue(undefined),
  };
});

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
    channelQuery = { data: mockChannel, isLoading: false };
  });

  it('marks the channel read on open (optimistic cache patch + PUT)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['userChannels'], [
      { channelID: 'ch-other', channelName: 'other', unread: true, unreadCount: 2 },
      { channelID: 'ch-1', channelName: 'general', unread: true, unreadCount: 4 },
    ]);
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/channel/general']}>
          <Routes>
            <Route path="/channel/:id" element={<ChannelView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: 'general' });
    // Optimistic: the cached row is zeroed immediately so the sidebar clears.
    const cached = qc.getQueryData<{ channelID: string; unread?: boolean; unreadCount?: number }[]>(['userChannels']);
    const opened = cached?.find((c) => c.channelID === 'ch-1');
    const untouched = cached?.find((c) => c.channelID === 'ch-other');
    expect(opened).toMatchObject({ unread: false, unreadCount: 0 });
    expect(untouched).toMatchObject({ unread: true, unreadCount: 2 });
    // Persisted server-side.
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
  });

  it('renders channel name in header', () => {
    const { container } = renderChannelView();
    expect(screen.getByRole('heading', { name: 'general' })).toBeInTheDocument();
    expect(container.querySelector('header')?.className).toContain('shrink-0');
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

  it('keeps the message list above the input as flat siblings of MessageDropZone', () => {
    // Regression: TypingIndicator was once `absolute bottom-0` of its
    // nearest positioned ancestor (MessageDropZone, which wraps the input
    // too) so it anchored *below* the input. It later moved into normal
    // flow, and now lives inside MessageInput's `aboveInput` slot (glued
    // directly above the input box). Either way the dropzone DOM must stay
    // flat — MessageList a direct child, above the input child — because an
    // earlier attempt to wrap MessageList in its own `relative flex-1`
    // container broke overflow scroll (DMs stopped scrolling, channels
    // drifted on send).
    const { container } = renderChannelView();
    const dropzone = container.querySelector('div.relative.flex.flex-1.flex-col.min-h-0');
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

  it('shows not found only for real 404 channel responses', () => {
    channelQuery = { error: new ApiError(404, 'not found'), isLoading: false };
    renderChannelView();
    expect(screen.getByTestId('not-found-page')).toHaveTextContent('Channel not found');
  });

  it('shows access denied for forbidden channels', () => {
    channelQuery = { error: new ApiError(403, 'forbidden'), isLoading: false };
    renderChannelView();
    expect(screen.getByTestId('resource-error-403')).toHaveTextContent('Channel access denied');
  });

  it('does not show the not-found page for server errors', () => {
    channelQuery = { error: new ApiError(500, 'server exploded'), isLoading: false };
    renderChannelView();
    expect(screen.queryByTestId('not-found-page')).toBeNull();
    expect(screen.getByTestId('resource-error-500')).toHaveTextContent('Channel unavailable');
  });
});
