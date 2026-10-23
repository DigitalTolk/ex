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
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from './ChannelView';
import type { Channel, ChannelMembership } from '@/types';
import { queryKeys } from '@/lib/query-keys';

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
const messagesFor = vi.fn();

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
  useOptionalUnread: () => undefined,
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

vi.mock('@/hooks/useChannels', async (orig) => ({
  // The real useUserChannels, reading the cache the test fills.
  useUserChannels: (await orig<typeof import('@/hooks/useChannels')>()).useUserChannels,
  useChannelBySlug: () => channelQuery,
  useChannelMembers: () => ({ data: mockMembers }),
  useBrowseChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useMuteChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useUnarchiveChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useLeaveChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateChannelDescription: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Counts renders of the chat view's header, memoized like the real one: it
// must not re-render for another channel's sidebar change.
const headerRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/layout/Header', async () => {
  const { memo } = await import('react');
  return {
    Header: memo(function Header({ muted }: { muted?: boolean }) {
      headerRenders.count++;
      return <div data-testid="header-stub" data-muted={muted ? 'true' : 'false'} />;
    }),
  };
});

vi.mock('@/hooks/useMessages', () => ({
  useChannelMessages: (id: string | undefined, anchor?: string) => {
    messagesFor(id, anchor);
    return {
      data: { pages: [{ items: [] }] },
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      fetchNextPage: vi.fn(),
    };
  },
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

// The server's channel list: a refetch (opening the chat marks it read, which
// refreshes the list) returns what the test last put in the cache.
const server = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    apiFetch: vi.fn(async (url: string) => (url === '/api/v1/channels' ? server.rows : undefined)),
  };
});

// --- tests ---------------------------------------------------------------

const rows = [
  { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
  { channelID: 'ch-2', channelName: 'random', channelType: 'public', role: 1 },
];

describe('ChannelView subscription breadth', () => {
  // React Query delivers cache changes to observers on a later tick.
  const update = async (qc: QueryClient, fn: (prev: typeof rows) => typeof rows) => {
    await act(async () => {
      qc.setQueryData(queryKeys.userChannels(), fn);
      server.rows = qc.getQueryData(queryKeys.userChannels()) as unknown[];
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  it('ignores sidebar changes to other channels, and still follows its own row', async () => {
    channelQuery = { data: mockChannel, isLoading: false };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(queryKeys.userChannels(), rows);
    server.rows = rows;
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/channel/general']}>
          <Routes>
            <Route path="/channel/:id" element={<ChannelView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('header-stub')).toHaveAttribute('data-muted', 'false');
    // Let the mount's own cache work (marking the channel read) settle first.
    await update(qc, (prev) => prev);
    const before = headerRenders.count;

    // A message lands in ~random: its sidebar row (only) changes.
    await update(qc, (prev) => prev.map((r) => (r.channelID === 'ch-2' ? { ...r, unread: true, unreadCount: 3 } : r)));
    expect(headerRenders.count).toBe(before);

    // This channel is muted from elsewhere: the header shows it.
    await update(qc, (prev) => prev.map((r) => (r.channelID === 'ch-1' ? { ...r, muted: true } : r)));
    expect(screen.getByTestId('header-stub')).toHaveAttribute('data-muted', 'true');
  });
});
