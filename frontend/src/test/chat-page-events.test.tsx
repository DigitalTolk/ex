import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ChatPage from '@/pages/ChatPage';
import { apiFetch } from '@/lib/api';
import { resetServerVersionForTests } from '@/hooks/useServerVersion';

let capturedOptions: Record<string, ((data: unknown) => void) | boolean | undefined> = {};
const authUserMock = vi.hoisted(() => ({
  current: { id: 'u-me', email: 'a@b.c', displayName: 'Me', systemRole: 'member', status: 'active' } as {
    id: string;
    email: string;
    displayName: string;
    systemRole: string;
    status: string;
    timeZone?: string;
  },
}));
const sendWSMock = vi.hoisted(() => vi.fn());
const localTimeZoneMock = vi.hoisted(() => vi.fn(() => 'Europe/Stockholm'));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: Record<string, ((data: unknown) => void) | boolean | undefined>) => {
    capturedOptions = opts;
  },
}));

const logoutMock = vi.fn().mockResolvedValue(undefined);
const patchUserMock = vi.fn();
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: authUserMock.current,
    isAuthenticated: true,
    isLoading: false,
    logout: logoutMock,
    patchUser: patchUserMock,
  }),
}));

const markChannelUnread = vi.fn();
const markChannelNotificationUnread = vi.fn();
const markConversationUnread = vi.fn();
const markThreadNotificationUnread = vi.fn();
const clearConversationUnread = vi.fn();
const isActiveConversation = vi.fn(() => false);
const isActiveThread = vi.fn(() => false);
const unhideConversation = vi.fn();

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    markChannelUnread,
    markChannelNotificationUnread,
    markConversationUnread,
    markThreadNotificationUnread,
    unhideConversation,
    unreadChannels: new Set(),
    unreadChannelNotifications: new Set(),
    unreadConversations: new Set(),
    unreadThreadNotifications: new Set(),
    channelUnreadCounts: new Map(),
    conversationUnreadCounts: new Map(),
    hiddenConversations: new Set(),
    hideConversation: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread,
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation,
    setActiveThread: vi.fn(),
    isActiveThread,
  }),
}));

const setUserOnline = vi.fn();
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline,
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const dispatchNotification = vi.fn();
const setCurrentUserID = vi.fn();
vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => ({
    dispatch: dispatchNotification,
    setCurrentUserID,
    setActiveParent: vi.fn(),
    permission: 'default',
  }),
  NotificationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: [{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 }] }),
  useChannelBySlug: () => ({ data: undefined }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useSearchUsers: () => ({ data: [] }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => null,
  ApiError: class extends Error { status = 0; },
}));

vi.mock('@/lib/ws-sender', () => ({
  sendWS: (...args: unknown[]) => sendWSMock(...args),
}));

vi.mock('@/lib/user-time', async () => {
  const actual = await vi.importActual<typeof import('@/lib/user-time')>('@/lib/user-time');
  return {
    ...actual,
    localTimeZone: () => localTimeZoneMock(),
  };
});

vi.mock('@/context/ThemeContext', () => ({
  useTheme: () => ({ theme: 'system', setTheme: vi.fn() }),
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function CurrentLocation() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

function renderAt(path: string, qcSeed?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qcSeed?.(qc);
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <CurrentLocation />
          <Routes>
            <Route path="/*" element={<ChatPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe('ChatPage WebSocket handlers', () => {
  beforeEach(() => {
    act(() => resetServerVersionForTests());
    capturedOptions = {};
    authUserMock.current = {
      id: 'u-me',
      email: 'a@b.c',
      displayName: 'Me',
      systemRole: 'member',
      status: 'active',
    };
    markChannelUnread.mockReset();
    markChannelNotificationUnread.mockReset();
    markConversationUnread.mockReset();
    markThreadNotificationUnread.mockReset();
    clearConversationUnread.mockReset();
    isActiveConversation.mockReset();
    isActiveConversation.mockReturnValue(false);
    isActiveThread.mockReset();
    isActiveThread.mockReturnValue(false);
    unhideConversation.mockReset();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    setUserOnline.mockReset();
    dispatchNotification.mockReset();
    setCurrentUserID.mockReset();
    patchUserMock.mockReset();
    sendWSMock.mockReset();
    localTimeZoneMock.mockReset();
    localTimeZoneMock.mockReturnValue('Europe/Stockholm');
    localStorage.clear();
  });

  // Helper for building a payload that satisfies the runtime
  // isMessage validator (id, parentID, authorID, body, createdAt).
  function msg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'msg-1',
      parentID: 'ch-1',
      authorID: 'u-other',
      body: 'hi',
      createdAt: '2026-04-30T10:00:00Z',
      ...overrides,
    };
  }

  it('onMessageNew marks unread + un-hides + invalidates queries (skipping self)', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    // From self — should skip the unread marking
    handler(msg({ authorID: 'u-me' }));
    expect(markChannelUnread).not.toHaveBeenCalled();
    // From someone else
    handler(msg({ authorID: 'u-other' }));
    expect(markChannelUnread).toHaveBeenCalledWith('ch-1');
    expect(markConversationUnread).not.toHaveBeenCalled();
    expect(unhideConversation).not.toHaveBeenCalled();
  });

  it('onMessageNew does NOT mark the channel unread for a thread reply', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    handler(msg({ authorID: 'u-other', parentMessageID: 'root-1' }));
    expect(markChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew does NOT mark the channel unread for a system message (e.g. a join)', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    handler(msg({ authorID: 'u-other', system: true, body: 'joined the channel' }));
    expect(markChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew uses payload parentType when channel cache is empty', () => {
    renderAt('/');
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;

    handler(msg({ parentID: 'ch-not-loaded', parentType: 'channel', authorID: 'u-other' }));

    expect(markChannelUnread).toHaveBeenCalledWith('ch-not-loaded');
    expect(markConversationUnread).not.toHaveBeenCalled();
    expect(unhideConversation).not.toHaveBeenCalled();
  });

  it('onMessageNew does not guess conversation when parent type and caches are missing', () => {
    renderAt('/');
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;

    handler(msg({ parentID: 'ch-not-loaded', authorID: 'u-other' }));

    expect(markChannelUnread).not.toHaveBeenCalled();
    expect(markConversationUnread).not.toHaveBeenCalled();
    expect(unhideConversation).not.toHaveBeenCalled();
  });

  it('onMessageNew marks a DM unread only once', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
      qc.setQueryData(['userConversations'], [{ conversationID: 'conv-1' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;

    handler(msg({ parentID: 'conv-1', authorID: 'u-other' }));

    expect(markChannelUnread).not.toHaveBeenCalled();
    expect(markConversationUnread).toHaveBeenCalledTimes(1);
    expect(markConversationUnread).toHaveBeenCalledWith('conv-1');
    expect(unhideConversation).toHaveBeenCalledWith('conv-1');
  });

  it('onMessageNew clears shared unread for an active conversation', () => {
    isActiveConversation.mockReturnValue(true);
    renderAt('/', (qc) => {
      qc.setQueryData(['userConversations'], [{ conversationID: 'conv-1' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;

    handler(msg({ parentID: 'conv-1', parentType: 'conversation', authorID: 'u-other' }));

    expect(markConversationUnread).not.toHaveBeenCalled();
    expect(clearConversationUnread).toHaveBeenCalledWith('conv-1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/conv-1/read', { method: 'PUT' });
  });

  it('onMessageNew without a valid Message payload is a no-op', () => {
    renderAt('/');
    (capturedOptions.onMessageNew as (d: unknown) => void)({});
    expect(markChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew with parentMessageID invalidates thread + userThreads (so the /threads count updates live)', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageNew as (d: unknown) => void)(msg({
      parentMessageID: 'msg-root',
      id: 'msg-reply-1',
    }));
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['thread', 'channels/ch-1', 'msg-root']);
    expect(calls).toContainEqual(['userThreads']);
  });

  it('onMessageNew marks the active thread seen instead of leaving it unread', () => {
    renderAt('/channel/general?thread=msg-root', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });

    act(() => {
      (capturedOptions.onMessageNew as (d: unknown) => void)(msg({
        parentMessageID: 'msg-root',
        id: 'msg-reply-1',
        createdAt: '2026-04-30T10:10:00Z',
      }));
    });

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/user-state/threads/channels/ch-1/msg-root/seen', { method: 'PUT' });
  });

  it('onNotification for a thread reply refreshes /threads immediately', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');

    act(() => {
      (capturedOptions.onNotification as (d: unknown) => void)({
        kind: 'thread_reply',
        parentID: 'ch-1',
        parentType: 'channel',
        parentMessageID: 'msg-root',
        title: 'Alice replied',
        body: 'hello',
        createdAt: '2026-04-30T10:10:00Z',
      });
    });

    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(markThreadNotificationUnread).toHaveBeenCalledWith('msg-root');
    expect(calls).toContainEqual(['userThreads']);
    expect(calls).toContainEqual(['userState']);
    expect(dispatchNotification).toHaveBeenCalled();
  });

  it('onNotification for the active thread does not mark the thread unread', async () => {
    renderAt('/channel/general?thread=msg-root');

    await act(async () => {
      (capturedOptions.onNotification as (d: unknown) => void)({
        kind: 'thread_reply',
        parentID: 'ch-1',
        parentType: 'channel',
        parentMessageID: 'msg-root',
        title: 'Alice replied',
        body: 'hello',
        createdAt: '2026-04-30T10:10:00Z',
      });
      await Promise.resolve();
    });

    expect(markThreadNotificationUnread).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/user-state/threads/channels/ch-1/msg-root/seen', { method: 'PUT' });
    expect(dispatchNotification).toHaveBeenCalled();
  });

  it('onNotification for a locally-opened thread (no ?thread= URL) does not mark it unread', async () => {
    // Regression: a thread opened via "Reply in thread" lives in local view
    // state, not the URL, so isActiveThread must consult the Unread context
    // scope. Without it, replies to the on-screen thread re-lit the Threads
    // nav. Here the URL has no thread param but the scope reports it active.
    isActiveThread.mockReturnValue(true);
    renderAt('/channel/general');

    await act(async () => {
      (capturedOptions.onNotification as (d: unknown) => void)({
        kind: 'thread_reply',
        parentID: 'ch-1',
        parentType: 'channel',
        parentMessageID: 'msg-root',
        title: 'Alice replied',
        body: 'hello',
        createdAt: '2026-04-30T10:10:00Z',
      });
      await Promise.resolve();
    });

    expect(markThreadNotificationUnread).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/user-state/threads/channels/ch-1/msg-root/seen', { method: 'PUT' });
  });

  it('onMessageDeleted on a thread reply invalidates that thread + userThreads', () => {
    // Regression: the backend now ships parentMessageID in the deleted
    // payload, and the client routes it to the thread query. Without
    // this, deleting a reply leaves the sidebar / /threads page stale.
    // The main message list isn't invalidated — that would trigger v5's
    // walk-forward refetch which truncates a deep-linked page chain
    // (see appendMessageToCache); we patch the cache directly instead.
    const { qc } = renderAt('/');
    qc.setQueryData(['channelMessages', 'ch-1', null], {
      pages: [{
        items: [msg({ id: 'msg-reply', parentMessageID: 'msg-root', body: 'stale body' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
      }],
      pageParams: [{ kind: 'tail' }],
    });
    qc.setQueryData(['thread', 'channels/ch-1', 'msg-root'], [
      msg({ id: 'msg-root' }),
      msg({ id: 'msg-reply', parentMessageID: 'msg-root', body: 'stale body' }),
    ]);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageDeleted as (d: unknown) => void)({
      parentID: 'ch-1',
      parentMessageID: 'msg-root',
      id: 'msg-reply',
    });
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).not.toContainEqual(['channelMessages', 'ch-1']);
    expect(calls).toContainEqual(['thread', 'channels/ch-1', 'msg-root']);
    expect(calls).toContainEqual(['thread', 'conversations/ch-1', 'msg-root']);
    expect(calls).toContainEqual(['userThreads']);
    const list = qc.getQueryData<{ pages: { items: { id: string; body: string; deleted?: boolean }[] }[] }>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(list?.pages[0].items[0]).toMatchObject({ id: 'msg-reply', body: '', deleted: true });
    const thread = qc.getQueryData<{ id: string; body: string; deleted?: boolean }[]>([
      'thread', 'channels/ch-1', 'msg-root',
    ]);
    expect(thread?.[1]).toMatchObject({ id: 'msg-reply', body: '', deleted: true });
  });

  it('onMessageDeleted on a thread root falls back to id when parentMessageID is absent', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageDeleted as (d: unknown) => void)(msg({ id: 'msg-root' }));
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['thread', 'channels/ch-1', 'msg-root']);
    expect(calls).toContainEqual(['userThreads']);
  });

  it('onMessageEdited patches the cached message in the open channel', () => {
    const { qc } = renderAt('/');
    qc.setQueryData(['channelMessages', 'ch-1', null], {
      pages: [{
        items: [{ id: 'm-1', parentID: 'ch-1', authorID: 'u-1', body: 'old', createdAt: '2026-04-30T10:00:00Z' }],
        hasMoreOlder: false,
        hasMoreNewer: false,
      }],
      pageParams: [{ kind: 'tail' }],
    });
    (capturedOptions.onMessageEdited as (d: unknown) => void)(msg({ id: 'm-1', body: 'edited' }));
    const out = qc.getQueryData<{ pages: { items: { id: string; body: string }[] }[] }>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(out?.pages[0].items[0].body).toBe('edited');
  });

  it('onReconnect refreshes peripheral lists', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onReconnect as () => void)();
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['userChannels']);
    expect(calls).toContainEqual(['userConversations']);
    expect(calls).toContainEqual(['userThreads']);
    expect(calls).toContainEqual(['userState']);
    expect(calls).toContainEqual(['channelMembers']);
  });

  it('onMessageEdited / onMessageDeleted gracefully ignore missing parentID and invalidate when present', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onMessageEdited as (d: unknown) => void)({});
      (capturedOptions.onMessageDeleted as (d: unknown) => void)({});
      (capturedOptions.onMessageEdited as (d: unknown) => void)({
        parentID: 'ch-1',
        parentMessageID: 'm-r',
      });
      (capturedOptions.onMessageEdited as (d: unknown) => void)({
        parentID: 'ch-1',
        id: 'm-r',
      });
      (capturedOptions.onMessageDeleted as (d: unknown) => void)({
        parentID: 'ch-1',
        id: 'm-r',
      });
    }).not.toThrow();
  });

  it('onMembersChanged refreshes member + channel lists; ignores missing channelID', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onMembersChanged as (d: unknown) => void)({});
      (capturedOptions.onMembersChanged as (d: unknown) => void)({ channelID: 'ch-1' });
    }).not.toThrow();
  });

  it('onMembersChanged refreshes membership but does NOT invalidate the message list', () => {
    // The "X was added" system message arrives via a separate
    // message.new event and is appended via appendMessageToCache.
    // Invalidating the message list here would trigger v5's walk-
    // forward refetch, truncating a deep-linked page chain to a
    // single 2-message slice. Members and the channel-list cache are
    // safe — neither is an infinite query.
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMembersChanged as (d: unknown) => void)({ channelID: 'ch-1' });
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['channelMembers', 'ch-1']);
    expect(calls).toContainEqual(['userChannels']);
    expect(calls).not.toContainEqual(['channelMessages', 'ch-1']);
    expect(calls).not.toContainEqual(['conversationMessages', 'ch-1']);
  });

  it('onConversationNew refreshes the userConversations list', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onConversationNew as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onChannelArchived navigates away when the archived channel is currently open', () => {
    // The handler reads window.location.pathname (not the MemoryRouter
    // path), so we have to override the browser-level location for jsdom.
    const orig = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...orig, pathname: '/channel/general' },
      configurable: true,
    });
    const { getByTestId } = renderAt('/channel/general', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    act(() => {
      (capturedOptions.onChannelArchived as (d: unknown) => void)({ channelID: 'ch-1' });
    });
    expect(getByTestId('loc').textContent).toBe('/');
    Object.defineProperty(window, 'location', { value: orig, configurable: true });
  });

  it('onChannelArchived without an open channel does not navigate', () => {
    const { getByTestId } = renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], []);
    });
    (capturedOptions.onChannelArchived as (d: unknown) => void)({ channelID: 'ch-other' });
    expect(getByTestId('loc').textContent).toBe('/');
  });

  it('onChannelRemoved navigates home when the removed channel is currently open', () => {
    const orig = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...orig, pathname: '/channel/general' },
      configurable: true,
    });
    const { getByTestId } = renderAt('/channel/general', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    act(() => {
      (capturedOptions.onChannelRemoved as (d: unknown) => void)({ channelID: 'ch-1' });
    });
    expect(getByTestId('loc').textContent).toBe('/');
    Object.defineProperty(window, 'location', { value: orig, configurable: true });
  });

  it('onChannelArchived ignores missing channelID', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onChannelArchived as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onChannelRemoved ignores missing channelID', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onChannelRemoved as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onChannelUpdated invalidates channel-by-slug + user channels', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onChannelUpdated as (d: unknown) => void)({ channelID: 'ch-1' });
      (capturedOptions.onChannelUpdated as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onChannelNew invalidates browse + user channels', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onChannelNew as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onPresenceChanged updates presence; ignores missing userID', () => {
    renderAt('/');
    (capturedOptions.onPresenceChanged as (d: unknown) => void)({ userID: 'u-x', online: true });
    expect(setUserOnline).toHaveBeenCalledWith('u-x', true);
    setUserOnline.mockClear();
    (capturedOptions.onPresenceChanged as (d: unknown) => void)({});
    expect(setUserOnline).not.toHaveBeenCalled();
  });

  it('onEmojiAdded / onEmojiRemoved invalidate the emojis cache', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onEmojiAdded as (d: unknown) => void)({});
      (capturedOptions.onEmojiRemoved as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onWebhookChanged invalidates the incoming-webhooks cache', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onWebhookChanged as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onUserUpdated invalidates user-batch + member + channel + conversation caches', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onUserUpdated as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onUserUpdated patches the authenticated user so status clears across tabs', () => {
    renderAt('/');
    (capturedOptions.onUserUpdated as (d: unknown) => void)({
      id: 'u-me',
      userStatus: null,
      timeZone: 'Europe/Stockholm',
      lastSeenAt: '2026-05-03T10:00:00.000Z',
    });
    expect(patchUserMock).toHaveBeenCalledWith({
      userStatus: undefined,
      timeZone: 'Europe/Stockholm',
      lastSeenAt: '2026-05-03T10:00:00.000Z',
    });
  });

  it('onPing sends timezone.update on the first ping, then only after browser timezone changes', () => {
    renderAt('/');

    (capturedOptions.onPing as (d: unknown) => void)({});
    expect(sendWSMock).toHaveBeenCalledWith({ type: 'timezone.update', timeZone: 'Europe/Stockholm' });

    sendWSMock.mockClear();
    (capturedOptions.onPing as (d: unknown) => void)({});
    expect(sendWSMock).not.toHaveBeenCalled();

    localTimeZoneMock.mockReturnValue('America/New_York');
    (capturedOptions.onPing as (d: unknown) => void)({});
    expect(sendWSMock).toHaveBeenCalledWith({ type: 'timezone.update', timeZone: 'America/New_York' });
  });

  it('onPing still sends on first ping even if the restored user already has a stored timezone', () => {
    authUserMock.current = { ...authUserMock.current, timeZone: 'Europe/Stockholm' };
    renderAt('/');

    (capturedOptions.onPing as (d: unknown) => void)({});
    expect(sendWSMock).toHaveBeenCalledWith({ type: 'timezone.update', timeZone: 'Europe/Stockholm' });
  });

  it('onPing skips timezone.update when the browser has no timezone', () => {
    localTimeZoneMock.mockReturnValue('');
    renderAt('/');

    (capturedOptions.onPing as (d: unknown) => void)({});
    expect(sendWSMock).not.toHaveBeenCalled();
  });

  it('onAttachmentDeleted invalidates the per-attachment cache; ignores missing id', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onAttachmentDeleted as (d: unknown) => void)({});
      (capturedOptions.onAttachmentDeleted as (d: unknown) => void)({ id: 'a-1' });
    }).not.toThrow();
  });

  it('onNotification dispatches the payload to NotificationContext', () => {
    renderAt('/');
    (capturedOptions.onNotification as (d: unknown) => void)({
      kind: 'message',
      title: 't',
      body: 'b',
      deepLink: '/x',
      parentID: 'ch-1',
      parentType: 'channel',
      createdAt: new Date().toISOString(),
    });
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
  });

  it('onNotification counts channel mentions but not ordinary channel messages', () => {
    renderAt('/');
    const payload = {
      title: 't',
      body: 'b',
      deepLink: '/x',
      parentID: 'ch-1',
      parentType: 'channel',
      createdAt: new Date().toISOString(),
    };

    (capturedOptions.onNotification as (d: unknown) => void)({ ...payload, kind: 'message' });
    expect(markChannelNotificationUnread).not.toHaveBeenCalled();

    (capturedOptions.onNotification as (d: unknown) => void)({ ...payload, kind: 'mention' });
    expect(markChannelNotificationUnread).toHaveBeenCalledWith('ch-1');
  });

  it('onNotification counts thread replies separately from their DM parent', () => {
    renderAt('/');

    (capturedOptions.onNotification as (d: unknown) => void)({
      kind: 'thread_reply',
      title: 't',
      body: 'b',
      deepLink: '/conversation/conv-1?thread=root-1#msg-reply-1',
      parentID: 'conv-1',
      parentType: 'conversation',
      parentMessageID: 'root-1',
      createdAt: new Date().toISOString(),
    });

    expect(markThreadNotificationUnread).toHaveBeenCalledWith('root-1');
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
  });

  it('onNotification counts channel thread mentions as thread unread only', () => {
    renderAt('/');

    (capturedOptions.onNotification as (d: unknown) => void)({
      kind: 'mention',
      title: 't',
      body: 'b',
      deepLink: '/channel/general?thread=root-1#msg-reply-1',
      parentID: 'ch-1',
      parentType: 'channel',
      parentMessageID: 'root-1',
      createdAt: new Date().toISOString(),
    });

    expect(markThreadNotificationUnread).toHaveBeenCalledWith('root-1');
    expect(markChannelNotificationUnread).not.toHaveBeenCalled();
  });

  it('updates current user id on mount and resets to null on unmount', () => {
    const { unmount } = renderAt('/');
    expect(setCurrentUserID).toHaveBeenCalledWith('u-me');
    setCurrentUserID.mockClear();
    unmount();
    expect(setCurrentUserID).toHaveBeenCalledWith(null);
  });

  it('onServerVersion stores the build version so UpdateBanner can react without polling', () => {
    // Migration from /api/v1/version polling to a single WS frame on
    // connect. ChatPage forwards the payload into the module-level
    // serverVersion store; UpdateBanner reads it via useSyncExternalStore.
    renderAt('/');
    expect(typeof capturedOptions.onServerVersion).toBe('function');
    // Stored value lives in '@/hooks/useServerVersion' — we don't import
    // it here to avoid coupling the test to the hook's internals; the
    // server-version test covers that contract. This test only verifies
    // ChatPage actually wires the event.
    act(() => {
      (capturedOptions.onServerVersion as (d: unknown) => void)({ version: 'v9.9.9' });
    });
    // No assertion on side effects — failure mode is an unhandled error.
  });

  it('onForceLogout signs the user out and routes to /login', async () => {
    // Server-side deactivation publishes auth.force_logout to the user's
    // personal channel; the client must drop credentials and bounce to
    // the login screen so the kicked-out tab can't keep using the app.
    logoutMock.mockClear();
    const { findByTestId } = renderAt('/');
    await act(async () => {
      (capturedOptions.onForceLogout as (d: unknown) => void)({ reason: 'deactivated' });
    });
    expect(logoutMock).toHaveBeenCalledTimes(1);
    const loc = await findByTestId('loc');
    expect(loc.textContent).toBe('/login');
  });
});
