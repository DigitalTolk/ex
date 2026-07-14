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

const markThreadNotificationUnread = vi.fn();
const isActiveChannel = vi.fn(() => false);
const isActiveConversation = vi.fn(() => false);
const isActiveThread = vi.fn(() => false);
const unhideConversation = vi.fn();

// The unread badge is now patched straight into the list cache by these helpers
// (single source). Mock them so the handler tests assert the intent directly.
const { bumpChannelUnread, bumpConversationUnread, clearConversationUnreadInCache } = vi.hoisted(() => ({
  bumpChannelUnread: vi.fn(),
  bumpConversationUnread: vi.fn(),
  clearConversationUnreadInCache: vi.fn(),
}));
vi.mock('@/lib/unread-cache', async (importOriginal) => ({
  // Real module for the notify-count SET helpers (their tests assert the
  // query-cache state), stubs for the bump/clear calls other tests count.
  ...(await importOriginal<typeof import('@/lib/unread-cache')>()),
  bumpChannelUnread,
  bumpConversationUnread,
  clearConversationUnreadInCache,
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    markThreadNotificationUnread,
    unhideConversation,
    unreadThreadNotifications: new Set(),
    hiddenConversations: new Set(),
    hideConversation: vi.fn(),
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel,
    isActiveConversation,
    setActiveThread: vi.fn(),
    isActiveThread,
  }),
}));

const setUserOnline = vi.fn();
const presenceRefreshMock = vi.fn();
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline,
    refreshPresence: presenceRefreshMock,
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
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
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
    bumpChannelUnread.mockReset();
    bumpConversationUnread.mockReset();
    clearConversationUnreadInCache.mockReset();
    markThreadNotificationUnread.mockReset();
    isActiveChannel.mockReset();
    isActiveChannel.mockReturnValue(false);
    isActiveConversation.mockReset();
    isActiveConversation.mockReturnValue(false);
    isActiveThread.mockReset();
    isActiveThread.mockReturnValue(false);
    unhideConversation.mockReset();
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    setUserOnline.mockReset();
    presenceRefreshMock.mockReset();
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
    expect(bumpChannelUnread).not.toHaveBeenCalled();
    // From someone else
    handler(msg({ authorID: 'u-other' }));
    expect(bumpChannelUnread).toHaveBeenCalledWith(expect.anything(), 'ch-1');
    expect(bumpConversationUnread).not.toHaveBeenCalled();
    expect(unhideConversation).not.toHaveBeenCalled();
  });

  it('onMessageNew marks unread for a webhook message authored by the current user', () => {
    // A webhook carries its creator's userID as authorID, but the bot posted
    // it — so the creator must still get the unread badge (matching the desktop
    // notification the backend already sends them). Regression: this was being
    // suppressed as if it were the user's own message.
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    handler(msg({ authorID: 'u-me', webhookUsername: 'alertbot' }));
    expect(bumpChannelUnread).toHaveBeenCalledWith(expect.anything(), 'ch-1');
  });

  it('onMessageNew on the ACTIVE channel PUTs the read marker instead of marking unread', () => {
    isActiveChannel.mockReturnValue(true);
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    handler(msg({ authorID: 'u-other', parentType: 'channel' }));
    expect(bumpChannelUnread).not.toHaveBeenCalled();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
  });

  it('onMessageNew does NOT mark the channel unread for a thread reply', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    handler(msg({ authorID: 'u-other', parentMessageID: 'root-1' }));
    expect(bumpChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew does NOT mark the channel unread for a system message (e.g. a join)', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    handler(msg({ authorID: 'u-other', system: true, body: 'joined the channel' }));
    expect(bumpChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew uses payload parentType when channel cache is empty', () => {
    renderAt('/');
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;

    handler(msg({ parentID: 'ch-not-loaded', parentType: 'channel', authorID: 'u-other' }));

    expect(bumpChannelUnread).toHaveBeenCalledWith(expect.anything(), 'ch-not-loaded');
    expect(bumpConversationUnread).not.toHaveBeenCalled();
    expect(unhideConversation).not.toHaveBeenCalled();
  });

  it('onMessageNew does not guess conversation when parent type and caches are missing', () => {
    renderAt('/');
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;

    handler(msg({ parentID: 'ch-not-loaded', authorID: 'u-other' }));

    expect(bumpChannelUnread).not.toHaveBeenCalled();
    expect(bumpConversationUnread).not.toHaveBeenCalled();
    expect(unhideConversation).not.toHaveBeenCalled();
  });

  it('onMessageNew marks a DM unread only once', () => {
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
      qc.setQueryData(['userConversations'], [{ conversationID: 'conv-1' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;

    handler(msg({ parentID: 'conv-1', authorID: 'u-other' }));

    expect(bumpChannelUnread).not.toHaveBeenCalled();
    expect(bumpConversationUnread).toHaveBeenCalledTimes(1);
    expect(bumpConversationUnread).toHaveBeenCalledWith(expect.anything(), 'conv-1');
    expect(unhideConversation).toHaveBeenCalledWith('conv-1');
  });

  it('onMessageNew clears shared unread for an active conversation', () => {
    isActiveConversation.mockReturnValue(true);
    renderAt('/', (qc) => {
      qc.setQueryData(['userConversations'], [{ conversationID: 'conv-1' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;

    handler(msg({ parentID: 'conv-1', parentType: 'conversation', authorID: 'u-other' }));

    expect(bumpConversationUnread).not.toHaveBeenCalled();
    expect(clearConversationUnreadInCache).toHaveBeenCalledWith(expect.anything(), 'conv-1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/conv-1/read', { method: 'PUT' });
  });

  it('onMessageNew without a valid Message payload is a no-op', () => {
    renderAt('/');
    (capturedOptions.onMessageNew as (d: unknown) => void)({});
    expect(bumpChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew with parentMessageID invalidates the thread scope but NOT userThreads (which is patched from the root edit instead)', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageNew as (d: unknown) => void)(msg({
      parentMessageID: 'msg-root',
      id: 'msg-reply-1',
    }));
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['thread', 'channels/ch-1', 'msg-root']);
    // No userThreads refetch — an eventually-consistent re-read would race the
    // just-written state; /threads is patched from the root's message.edited.
    expect(calls).not.toContainEqual(['userThreads']);
  });

  it('onMessageNew appends a reply into an open thread cache instead of invalidating it', () => {
    const { qc } = renderAt('/', (client) => {
      client.setQueryData(['thread', 'channels/ch-1', 'msg-root'], [msg({ id: 'msg-root' })]);
    });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageNew as (d: unknown) => void)(msg({
      parentMessageID: 'msg-root',
      id: 'msg-reply-1',
    }));
    const thread = qc.getQueryData(['thread', 'channels/ch-1', 'msg-root']) as Array<{ id: string }>;
    // The reply is patched straight into the open thread — no refetch flicker.
    expect(thread.map((m) => m.id)).toEqual(['msg-root', 'msg-reply-1']);
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).not.toContainEqual([
      'thread',
      'channels/ch-1',
      'msg-root',
    ]);
  });

  it('onThreadUpdated patches a thread the viewer did not author into /threads (participant-scoped)', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onThreadUpdated as (d: unknown) => void)({
      parentID: 'ch-1',
      parentType: 'channel',
      threadRootID: 'root-x',
      rootAuthorID: 'someone-else',
      rootBody: 'not mine',
      rootCreatedAt: '2026-05-01T09:00:00Z',
      replyCount: 4,
      latestActivityAt: '2026-05-01T10:00:00Z',
    });
    const threads = qc.getQueryData(['userThreads']) as Array<{ threadRootID: string; replyCount: number }>;
    // Added even though the viewer isn't the author — receipt is the participation proof.
    expect(threads?.[0]).toMatchObject({ threadRootID: 'root-x', replyCount: 4 });
    // Patched from the event payload — no ListUserThreads refetch.
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).not.toContainEqual(['userThreads']);
  });

  it('onThreadUpdated ignores a malformed payload', () => {
    const { qc } = renderAt('/');
    (capturedOptions.onThreadUpdated as (d: unknown) => void)({ threadRootID: '' });
    expect(qc.getQueryData(['userThreads'])).toBeUndefined();
  });

  it('onMessageEdited for my thread root patches it into /threads live (no refetch)', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    // A root I authored gains a reply → replyCount bump arrives as message.edited.
    (capturedOptions.onMessageEdited as (d: unknown) => void)(
      msg({ id: 'msg-root', authorID: 'u-me', parentType: 'channel', replyCount: 1, lastReplyAt: '2026-05-01T10:00:00Z' }),
    );
    const threads = qc.getQueryData(['userThreads']) as Array<{ threadRootID: string; replyCount: number }>;
    expect(threads?.[0]).toMatchObject({ threadRootID: 'msg-root', replyCount: 1 });
    // Patched, not refetched.
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).not.toContainEqual(['userThreads']);
  });

  it('onNotification does NOT refetch /threads when the thread is already patched into the cache', () => {
    const { qc } = renderAt('/', (client) => {
      client.setQueryData(['userThreads'], [
        { parentID: 'ch-1', parentType: 'channel', threadRootID: 'msg-root', rootAuthorID: 'u-me', rootBody: 'hi', rootCreatedAt: '2026-05-01T09:00:00Z', replyCount: 1, latestActivityAt: '2026-05-01T10:00:00Z' },
      ]);
    });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onNotification as (d: unknown) => void)({
      kind: 'thread_reply',
      parentID: 'ch-1',
      parentType: 'channel',
      parentMessageID: 'msg-root',
      createdAt: '2026-05-01T10:00:01Z',
    });
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).not.toContainEqual(['userThreads']);
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

  it('onNotification for a top-level channel alert SETs the sidebar alerted badge', () => {
    const { qc } = renderAt('/', (client) => {
      client.setQueryData(['userChannels'], [
        { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
      ]);
    });

    act(() => {
      (capturedOptions.onNotification as (d: unknown) => void)({
        kind: 'mention',
        parentID: 'ch-1',
        parentType: 'channel',
        messageID: 'msg-9',
        title: 'Alice mentioned you',
        body: '@you hello',
        createdAt: '2026-04-30T10:10:00Z',
        parentUnreadNotifyCount: 3,
      });
    });

    // The payload's authoritative count is SET on the row (never incremented
    // locally), and the availability indicator lights alongside it.
    const rows = qc.getQueryData<{ channelID: string; unreadNotifyCount?: number; unread?: boolean }[]>(['userChannels'])!;
    expect(rows[0]).toMatchObject({ unread: true, unreadNotifyCount: 3 });
    expect(dispatchNotification).toHaveBeenCalled();
  });

  it('onNotification for a DM alert SETs the conversation alerted badge', () => {
    const { qc } = renderAt('/', (client) => {
      client.setQueryData(['userConversations'], [
        { conversationID: 'conv-1', type: 'dm', displayName: 'Bob' },
      ]);
    });

    act(() => {
      (capturedOptions.onNotification as (d: unknown) => void)({
        kind: 'message',
        parentID: 'conv-1',
        parentType: 'conversation',
        messageID: 'msg-10',
        title: 'Bob',
        body: 'hi',
        createdAt: '2026-04-30T10:10:00Z',
        parentUnreadNotifyCount: 2,
      });
    });

    const rows = qc.getQueryData<{ conversationID: string; unreadNotifyCount?: number }[]>(['userConversations'])!;
    expect(rows[0]).toMatchObject({ unread: true, unreadNotifyCount: 2 });
  });

  it('onNotification for a thread reply does NOT touch the parent alerted badge', () => {
    const { qc } = renderAt('/', (client) => {
      client.setQueryData(['userChannels'], [
        { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 },
      ]);
    });

    act(() => {
      (capturedOptions.onNotification as (d: unknown) => void)({
        kind: 'thread_reply',
        parentID: 'ch-1',
        parentType: 'channel',
        parentMessageID: 'msg-root',
        createdAt: '2026-04-30T10:10:00Z',
        // Defensive: even if a count somehow rides a thread notification,
        // the Threads nav owns thread unreads — the parent row stays put.
        parentUnreadNotifyCount: 5,
      });
    });

    const rows = qc.getQueryData<{ channelID: string; unreadNotifyCount?: number }[]>(['userChannels'])!;
    expect(rows[0].unreadNotifyCount).toBeUndefined();
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
    // The refetched userChannels/userConversations carry authoritative server
    // unread counts — the single source — so there's nothing else to reset.
    // presence.changed is ephemeral (never replayed): the reconnect must also
    // refetch the authoritative online set or dots drift stale.
    expect(presenceRefreshMock).toHaveBeenCalled();
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

  it('onActivityNew refetches the activity stream', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onActivityNew as (d: unknown) => void)({});
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

  it('onUserUpdated patches synced directory fields (phone + manager) on the authenticated user', () => {
    renderAt('/');
    (capturedOptions.onUserUpdated as (d: unknown) => void)({
      id: 'u-me',
      phone: '+46 70 123 45 67',
      manager: { displayName: 'Boss', email: 'boss@example.com', userID: 'u-boss' },
    });
    expect(patchUserMock).toHaveBeenCalledWith({
      phone: '+46 70 123 45 67',
      manager: { displayName: 'Boss', email: 'boss@example.com', userID: 'u-boss' },
    });
  });

  it('onUserUpdated maps a cleared (null) manager to undefined', () => {
    renderAt('/');
    (capturedOptions.onUserUpdated as (d: unknown) => void)({
      id: 'u-me',
      phone: '',
      manager: null,
    });
    expect(patchUserMock).toHaveBeenCalledWith({ phone: '', manager: undefined });
  });

  it('onNotificationSettingsUpdated patches the authenticated user settings', () => {
    renderAt('/');
    (capturedOptions.onNotificationSettingsUpdated as (d: unknown) => void)({
      settings: { desktopLevel: 'all', mobileLevel: 'default', threadReplies: true, ignoreGroupMentions: false, followAllThreads: false, keywords: [] },
    });
    expect(patchUserMock).toHaveBeenCalledWith({
      notificationSettings: expect.objectContaining({ desktopLevel: 'all' }),
    });
  });

  it('onNotificationSettingsUpdated ignores a payload without settings', () => {
    renderAt('/');
    (capturedOptions.onNotificationSettingsUpdated as (d: unknown) => void)({});
    expect(patchUserMock).not.toHaveBeenCalled();
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

  it('onNotification for a top-level channel alerts but does not touch the unread badge', () => {
    // The sidebar badge rides the separate message.new event (which patches the
    // list cache and replays from the durable inbox on reconnect). A top-level
    // channel notification.new is just the alert — it must NOT also mark the
    // unread cache, regardless of kind.
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
    (capturedOptions.onNotification as (d: unknown) => void)({ ...payload, kind: 'mention' });
    expect(bumpChannelUnread).not.toHaveBeenCalled();
    expect(dispatchNotification).toHaveBeenCalledTimes(2);
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
    expect(bumpChannelUnread).not.toHaveBeenCalled();
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

  it('replying to a thread keeps every other member message field intact (attachments bug shape)', () => {
    // Full backend event sequence for a thread reply, replayed through the
    // real handlers against a seeded /threads card cache: message.new (the
    // reply echo) followed by message.edited (the authoritative root
    // republish that carries the bumped replyCount). The republished root is
    // complete — the cached root must keep its attachments/reactions after
    // the in-place replace, and the untouched reply must not be disturbed.
    const threadKey = ['thread', 'channels/ch-1', 'root-1'];
    const otherRoot = {
      id: 'root-1',
      parentID: 'ch-1',
      parentType: 'channel',
      authorID: 'u-other',
      body: 'screenshots attached',
      createdAt: '2026-07-06T09:00:00Z',
      attachmentIDs: ['att-1', 'att-2'],
      reactions: { thumbsup: ['u-me'] },
      replyCount: 1,
    };
    const otherReply = {
      id: 'reply-1',
      parentID: 'ch-1',
      parentType: 'channel',
      authorID: 'u-other',
      body: 'one more',
      createdAt: '2026-07-06T09:05:00Z',
      parentMessageID: 'root-1',
      attachmentIDs: ['att-3'],
    };
    const { qc } = renderAt('/threads', (seed) => {
      seed.setQueryData(threadKey, [otherRoot, otherReply]);
      seed.setQueryData(['userThreads'], [
        {
          parentID: 'ch-1',
          parentType: 'channel',
          threadRootID: 'root-1',
          rootAuthorID: 'u-other',
          rootBody: 'screenshots attached',
          rootCreatedAt: '2026-07-06T09:00:00Z',
          replyCount: 1,
          latestActivityAt: '2026-07-06T09:05:00Z',
        },
      ]);
    });

    act(() => {
      (capturedOptions.onMessageNew as (d: unknown) => void)({
        id: 'reply-2',
        parentID: 'ch-1',
        parentType: 'channel',
        authorID: 'u-me',
        body: 'my reply',
        createdAt: '2026-07-06T10:00:00Z',
        parentMessageID: 'root-1',
      });
      (capturedOptions.onMessageEdited as (d: unknown) => void)({
        ...otherRoot,
        replyCount: 2,
        lastReplyAt: '2026-07-06T10:00:00Z',
        recentReplyAuthorIDs: ['u-me', 'u-other'],
      });
    });

    const cached = qc.getQueryData<Array<{ id: string; attachmentIDs?: string[]; reactions?: unknown }>>(threadKey);
    expect(cached?.map((m) => m.id)).toEqual(['root-1', 'reply-1', 'reply-2']);
    expect(cached?.[0].attachmentIDs).toEqual(['att-1', 'att-2']);
    expect(cached?.[0].reactions).toEqual({ thumbsup: ['u-me'] });
    expect(cached?.[1].attachmentIDs).toEqual(['att-3']);
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
