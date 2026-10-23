import { describe, it, expect, vi, beforeEach } from 'vitest';

// A new message patches one page of the cached list; the view used to walk
// every loaded page — every message, every reaction — to collect user ids on
// each arrival. Mocks follow ChannelView.test.tsx.
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
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from './ChannelView';
import type { Channel, ChannelMembership, Message } from '@/types';
import { collectMessageUserIDs } from '@/lib/message-users';

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
// The loaded message pages the view reads; a test swaps in a patched copy.
const pagesState = vi.hoisted(() => ({ pages: [] as { items: Message[] }[] }));
// Wrapped, not replaced: counts which pages the view walks for user ids.
vi.mock('@/lib/message-users', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/message-users')>();
  return { ...actual, collectMessageUserIDs: vi.fn(actual.collectMessageUserIDs) };
});
let userChannels: { channelID: string; channelName: string; channelType?: string }[] = [];
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

vi.mock('@/hooks/useChannels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useChannels')>()),
  useChannelBySlug: () => channelQuery,
  useChannelMembers: () => ({ data: mockMembers }),
  useUserChannels: () => ({ data: userChannels }),
  useBrowseChannels: () => ({ data: [] }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useJoinChannel: () => ({ mutate: vi.fn(), isPending: false }),
  useMuteChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useMessages', () => ({
  useChannelMessages: (id: string | undefined, anchor?: string) => {
    messagesFor(id, anchor);
    return {
      data: { pages: pagesState.pages },
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

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    apiFetch: vi.fn().mockResolvedValue(undefined),
  };
});

// --- tests ---------------------------------------------------------------

function page(prefix: string, authors: string[]): { items: Message[] } {
  return {
    items: authors.map((authorID, i) => ({
      id: `${prefix}-${i}`,
      parentID: 'ch-1',
      authorID,
      body: `${prefix} ${i}`,
      createdAt: `2026-01-0${i + 1}T00:00:00Z`,
    })),
  };
}

describe('ChannelView user ids of the loaded pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelQuery = { data: mockChannel, isLoading: false };
    userChannels = [];
  });

  it('walks only the page an arrival changed', () => {
    const newest = page('p0', ['u-1', 'u-2']);
    const older = page('p1', ['u-3']);
    const oldest = page('p2', ['u-4', 'u-5']);
    pagesState.pages = [newest, older, oldest];
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/channel/general']}>
          <Routes>
            <Route path="/channel/:id" element={<ChannelView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(tree());
    const walked = () => vi.mocked(collectMessageUserIDs).mock.calls.map(([items]) => items);
    expect(walked()).toEqual(expect.arrayContaining([newest.items, older.items, oldest.items]));

    // A message arrives: the newest page is replaced, the others are not.
    vi.mocked(collectMessageUserIDs).mockClear();
    const arrived = { items: [{ ...newest.items[0], id: 'p0-new', authorID: 'u-9' }, ...newest.items] };
    pagesState.pages = [arrived, older, oldest];
    view.rerender(tree());
    expect(walked()).toEqual([arrived.items]);
  });
});
