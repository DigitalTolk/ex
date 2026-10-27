import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ChatPage from '@/pages/ChatPage';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { forceAwayUntilInput, resetUserActivityForTests } from '@/lib/user-activity';
import { usePresenceStore } from '@/stores/presence';
import { endReadSession, getUnreadAnchor, holdRead, isReadHeld, setAtBottom, setAtLiveTail, threadReadKey, useMissedArrivals } from '@/lib/read-position';
import { eventCallbacks, expectInvalidPayloadReported, type CapturedWSOptions } from '@/test/ws-frames';

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
    capturedOptions = eventCallbacks(opts as unknown as CapturedWSOptions) as typeof capturedOptions;
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
const { bumpChannelUnread, bumpConversationUnread, clearChannelUnreadInCache, clearConversationUnreadInCache } = vi.hoisted(() => ({
  bumpChannelUnread: vi.fn(),
  bumpConversationUnread: vi.fn(),
  clearChannelUnreadInCache: vi.fn(),
  clearConversationUnreadInCache: vi.fn(),
}));
vi.mock('@/lib/unread-cache', async (importOriginal) => ({
  // Real module for the notify-count SET helpers (their tests assert the
  // query-cache state), stubs for the bump/clear calls other tests count.
  ...(await importOriginal<typeof import('@/lib/unread-cache')>()),
  bumpChannelUnread,
  bumpConversationUnread,
  clearChannelUnreadInCache,
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

const presenceRefreshMock = vi.fn();
vi.mock('@/context/PresenceContext', () => ({
  refreshPresence: (...args: unknown[]) => presenceRefreshMock(...args),
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
  // Applies `select` like the real hook (ChannelView selects its own row).
  useUserChannels: (opts?: { select?: (rows: never[]) => unknown }) => {
    const rows = [{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 }] as never[];
    return { data: opts?.select && rows ? opts.select(rows) : rows };
  },
  useChannelBySlug: () => ({ data: undefined }),
  useCreateChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  // Applies `select` like the real hook (ConversationView selects its row's name).
  useUserConversations: (opts?: { select?: (rows: never[]) => unknown }) => {
    const rows = [] as never[];
    return { data: opts?.select && rows ? opts.select(rows) : rows };
  },
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useUserLookup: () => ({ data: [] }),
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
    // The attention model is a module singleton — a hard-away latched by one
    // test must not leak into the next.
    resetUserActivityForTests();
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
    clearChannelUnreadInCache.mockReset();
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
    // Mirrors the conversation arm: a badge left over from an idle spell is
    // cleared client-side too, not just server-side (review finding: the
    // channel arm used to skip the cache clear, leaving a stale badge until
    // an unrelated refetch).
    expect(clearChannelUnreadInCache).toHaveBeenCalledWith(expect.anything(), 'ch-1');
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
  });

  // THE "no notification from the DM I last had open" regression: an OPEN
  // route is not a READING user. When the window is blurred/hidden (here:
  // hard-away, one of the not-attentive arms), auto-marking the active
  // parent read erased the unread badge / bold row / title count the moment
  // the transient OS banner dismissed — no trace the message ever arrived,
  // on desktop OR (via read-sync) on the phone. Not attentive ⇒ bump the
  // badge like any other parent; the view marks read on window re-focus.
  it('onMessageNew on the ACTIVE channel while NOT attentive bumps unread instead of auto-reading', () => {
    isActiveChannel.mockReturnValue(true);
    forceAwayUntilInput();
    renderAt('/', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    handler(msg({ authorID: 'u-other', parentType: 'channel' }));
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
    expect(bumpChannelUnread).toHaveBeenCalledWith(expect.anything(), 'ch-1');
  });

  it('onMessageNew on the ACTIVE conversation while NOT attentive bumps unread instead of auto-reading', () => {
    isActiveConversation.mockReturnValue(true);
    forceAwayUntilInput();
    renderAt('/', (qc) => {
      qc.setQueryData(['userConversations'], [{ conversationID: 'conv-1' }]);
    });
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    handler(msg({ parentID: 'conv-1', authorID: 'u-other', parentType: 'conversation' }));
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith('/api/v1/conversations/conv-1/read', { method: 'PUT' });
    expect(clearConversationUnreadInCache).not.toHaveBeenCalled();
    expect(bumpConversationUnread).toHaveBeenCalledWith(expect.anything(), 'conv-1');
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
    expectInvalidPayloadReported('message.new', () => (capturedOptions.onMessageNew as (d: unknown) => void)({}));
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
    const { qc } = renderAt('/', (client) => {
      client.setQueryData(['userThreads'], []);
    });
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
    expectInvalidPayloadReported('thread.updated', () =>
      (capturedOptions.onThreadUpdated as (d: unknown) => void)({ threadRootID: '' }),
    );
    expect(qc.getQueryData(['userThreads'])).toBeUndefined();
  });

  // The root's echo reaches the whole channel, so it updates a thread already
  // listed and adds none — not even my own, which I may have unfollowed (a
  // new row comes with thread.updated, sent to followers only).
  it('onMessageEdited for a thread root patches its listed row live (no refetch), and adds none', () => {
    const { qc } = renderAt('/', (client) => {
      client.setQueryData(['userThreads'], [
        { parentID: 'ch-1', parentType: 'channel', threadRootID: 'msg-root', rootAuthorID: 'u-other', rootBody: 'hi', rootCreatedAt: '2026-05-01T09:00:00Z', replyCount: 1, latestActivityAt: '2026-05-01T09:30:00Z' },
      ]);
    });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageEdited as (d: unknown) => void)(
      msg({ id: 'msg-root', authorID: 'u-other', parentType: 'channel', replyCount: 2, lastReplyAt: '2026-05-01T10:00:00Z' }),
    );
    (capturedOptions.onMessageEdited as (d: unknown) => void)(
      msg({ id: 'msg-mine', authorID: 'u-me', parentType: 'channel', replyCount: 1, lastReplyAt: '2026-05-01T10:00:00Z' }),
    );
    const threads = qc.getQueryData(['userThreads']) as Array<{ threadRootID: string; replyCount: number }>;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ threadRootID: 'msg-root', replyCount: 2 });
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

  // After a socket gap — a reconnect, or a replay the server could no longer
  // serve — everything not in the durable inbox is refetched. That includes
  // what ephemeral events keep current: the activity feed and pending
  // reminders (a reminder set, cancelled or fired on another device while
  // disconnected used to linger), the Scheduled list, and presence.
  it.each(['onReconnect', 'onReplayExhausted'])('%s refreshes everything the inbox does not replay', (handler) => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    presenceRefreshMock.mockClear();
    (capturedOptions[handler] as () => void)();
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    for (const key of [
      ['userChannels'],
      ['userConversations'],
      ['userThreads'],
      ['userState'],
      ['drafts'],
      ['scheduledMessages'],
      ['channelMembers'],
      ['activity'],
      ['reminders'],
      // Kept current only by events, never by a timer (wsLiveQueryOptions):
      // the sidebar's categories and every cached thread.
      ['sidebarCategories'],
      ['thread'],
    ]) {
      expect(calls).toContainEqual(key);
    }
    expect(presenceRefreshMock).toHaveBeenCalledWith(qc);
  });

  it('onMessageEdited / onMessageDeleted gracefully ignore missing parentID and invalidate when present', () => {
    renderAt('/');
    // None of these is a whole message: each is reported, none is handled.
    expectInvalidPayloadReported(['message.edited', 'message.deleted', 'message.edited', 'message.edited'], () => {
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
    });
    // A compact delete ({id, parentID}) is a whole message.deleted.
    expect(() =>
      (capturedOptions.onMessageDeleted as (d: unknown) => void)({
        parentID: 'ch-1',
        id: 'm-r',
      }),
    ).not.toThrow();
  });

  it('onMembersChanged refreshes member + channel lists; ignores missing channelID', () => {
    renderAt('/');
    expectInvalidPayloadReported('members.changed', () => (capturedOptions.onMembersChanged as (d: unknown) => void)({}));
    expect(() => (capturedOptions.onMembersChanged as (d: unknown) => void)({ channelID: 'ch-1' })).not.toThrow();
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

  it('onChannelArchived keeps the open channel and refetches it read-only', () => {
    const orig = window.location;
    Object.defineProperty(window, 'location', {
      value: { ...orig, pathname: '/channel/general' },
      configurable: true,
    });
    let invalidate: ReturnType<typeof vi.spyOn> | undefined;
    const { getByTestId } = renderAt('/channel/general', (qc) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general' }]);
      invalidate = vi.spyOn(qc, 'invalidateQueries');
    });
    act(() => {
      (capturedOptions.onChannelArchived as (d: unknown) => void)({ channelID: 'ch-1' });
    });
    expect(getByTestId('loc').textContent).toBe('/channel/general');
    const keys = invalidate!.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["channel","ch-1"]', '["channelBySlug"]', '["userChannels"]']));
    Object.defineProperty(window, 'location', { value: orig, configurable: true });
  });

  it('onChannelUnarchived refetches the channel; ignores a missing channelID', () => {
    let invalidate: ReturnType<typeof vi.spyOn> | undefined;
    renderAt('/', (qc) => {
      invalidate = vi.spyOn(qc, 'invalidateQueries');
    });
    expectInvalidPayloadReported('channel.unarchived', () =>
      act(() => {
        (capturedOptions.onChannelUnarchived as (d: unknown) => void)({});
      }),
    );
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['channel', 'ch-2'] });
    act(() => {
      (capturedOptions.onChannelUnarchived as (d: unknown) => void)({ channelID: 'ch-2' });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['channel', 'ch-2'] });
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
    expectInvalidPayloadReported('channel.archived', () => (capturedOptions.onChannelArchived as (d: unknown) => void)({}));
  });

  it('onChannelRemoved ignores missing channelID', () => {
    renderAt('/');
    expectInvalidPayloadReported('channel.removed', () => (capturedOptions.onChannelRemoved as (d: unknown) => void)({}));
  });

  it('onChannelUpdated invalidates channel-by-slug, user channels and the channel listings', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    expect(() => (capturedOptions.onChannelUpdated as (d: unknown) => void)({ channelID: 'ch-1' })).not.toThrow();
    // A channel made private leaves the directory and the channel browser.
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(queryKeys.channelBySlug());
    expect(calls).toContainEqual(queryKeys.userChannels());
    expect(calls).toContainEqual(queryKeys.browseChannels());
    expectInvalidPayloadReported('channel.updated', () => (capturedOptions.onChannelUpdated as (d: unknown) => void)({}));
  });

  it('onChannelNew invalidates browse + user channels', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onChannelNew as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onPresenceChanged updates presence; ignores missing userID', () => {
    renderAt('/');
    act(() => (capturedOptions.onPresenceChanged as (d: unknown) => void)({ userID: 'u-x', online: true }));
    expect(usePresenceStore.getState().online.has('u-x')).toBe(true);
    const set = usePresenceStore.getState().online;
    expectInvalidPayloadReported('presence.changed', () =>
      act(() => (capturedOptions.onPresenceChanged as (d: unknown) => void)({})),
    );
    expect(usePresenceStore.getState().online).toBe(set);
    act(() => (capturedOptions.onPresenceChanged as (d: unknown) => void)({ userID: 'u-x', online: false }));
    expect(usePresenceStore.getState().online.has('u-x')).toBe(false);
  });

  it('onEmojiAdded / onEmojiRemoved patch the emoji list from the payload instead of refetching it', () => {
    const party = { name: 'party', imageURL: '/e/party.png', createdBy: 'u-1', createdAt: '2026-01-01T00:00:00Z' };
    const shipit = { name: 'shipit', imageURL: '/e/shipit.png', createdBy: 'u-2', createdAt: '2026-01-02T00:00:00Z' };
    const { qc } = renderAt('/', (seed) => seed.setQueryData(['emojis'], [party]));
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onEmojiAdded as (d: unknown) => void)(shipit);
    expect(qc.getQueryData(['emojis'])).toEqual([party, shipit]);
    (capturedOptions.onEmojiRemoved as (d: unknown) => void)({ name: 'party' });
    expect(qc.getQueryData(['emojis'])).toEqual([shipit]);
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).not.toContainEqual(['emojis']);
  });

  it('onWebhookChanged invalidates the incoming-webhooks cache', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onWebhookChanged as (d: unknown) => void)({});
    }).not.toThrow();
  });

  it('onProjectChanged refreshes the projects list and every open project', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onProjectChanged as (d: unknown) => void)({});
    expect(spy).toHaveBeenCalledWith({ queryKey: ['projects'] });
  });

  it('onSettingsUpdated and onRunnersChanged refetch what they change', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onSettingsUpdated as (d: unknown) => void)({});
    (capturedOptions.onRunnersChanged as (d: unknown) => void)({});
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(keys).toContainEqual(['workspace-settings']);
    expect(keys).toContainEqual(['runner-tokens']);
  });

  it('onActivityNew adds the carried item to the activity cache instead of refetching', () => {
    const { qc } = renderAt('/');
    qc.setQueryData(['activity'], { items: [], unread: 0, unreadByType: {} });
    vi.spyOn(qc, 'isFetching').mockReturnValue(0);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onActivityNew as (d: unknown) => void)({
      item: {
        id: 'a1',
        type: 'mention',
        createdAt: '2026-05-01T09:00:00Z',
        messageID: 'm-1',
        parentID: 'ch-1',
        parentType: 'channel',
        read: false,
      },
    });
    expect(qc.getQueryData<{ unread: number }>(['activity'])?.unread).toBe(1);
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).not.toContainEqual(['activity']);
  });

  it('onRemindersChanged refetches the pending reminders', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onRemindersChanged as (d: unknown) => void)({});
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).toContainEqual(['reminders']);
  });

  it('onScheduledMessagesChanged refetches the Scheduled list', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onScheduledMessagesChanged as (d: unknown) => void)({});
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).toContainEqual(['scheduledMessages']);
  });

  it('onActivityRead applies a remote mark-read to the cached feed', () => {
    const { qc } = renderAt('/');
    qc.setQueryData(['activity'], { items: [{ id: 'a1', type: 'mention', read: false }], unread: 1, unreadByType: { mention: 1 } });
    vi.spyOn(qc, 'isFetching').mockReturnValue(0);
    (capturedOptions.onActivityRead as (d: unknown) => void)({ all: true });
    expect(qc.getQueryData<{ unread: number }>(['activity'])?.unread).toBe(0);
  });

  it('onActivityRead refetches the activity stream so a remote mark-read clears this badge', () => {
    // GAP-3 regression: marking activity read on mobile must clear the desktop
    // badge — the handler refetches the feed (watermark is server-side truth).
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onActivityRead as (d: unknown) => void)({});
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['activity']);
  });

  it('onUserUpdated ignores a payload without a user id', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    expectInvalidPayloadReported('user.updated', () => (capturedOptions.onUserUpdated as (d: unknown) => void)({}));
    expect(spy).not.toHaveBeenCalled();
    expect(patchUserMock).not.toHaveBeenCalled();
  });

  // user.updated fires for every status set/clear (and the expired-status
  // sweeper), profile save and directory sync. It used to invalidate every
  // user-shaped cache — 6-8 refetches per client per event, a users batch
  // refetching all its ids. The payload is patched in instead.
  describe('onUserUpdated patches the payload into the cached copies', () => {
    const bob = { id: 'u-2', email: 'b@b.c', displayName: 'Bob', systemRole: 'member', status: 'active' };
    const cara = { id: 'u-3', email: 'c@c.c', displayName: 'Cara', systemRole: 'member', status: 'active' };
    function seed(qc: QueryClient) {
      qc.setQueryData(['user', 'u-2'], { ...bob });
      qc.setQueryData(['users-batch', ['u-2', 'u-3']], [bob, cara]);
      qc.setQueryData(['users-batch', ['u-3']], [cara]);
      qc.setQueryData(['allUsers'], [bob, cara]);
      qc.setQueryData(['searchUsers', 'bo'], [{ id: 'u-2', email: 'b@b.c', displayName: 'Bob' }]);
      qc.setQueryData(['users-directory', ''], [bob, cara]);
      qc.setQueryData(['channelMembers', 'ch-1'], [
        { channelID: 'ch-1', userID: 'u-2', role: 'member', displayName: 'Bob', joinedAt: '2026-01-01T00:00:00Z' },
        { channelID: 'ch-1', userID: 'u-3', role: 'member', displayName: 'Cara', joinedAt: '2026-01-01T00:00:00Z' },
      ]);
      qc.setQueryData(['channelMembers', 'ch-2'], [
        { channelID: 'ch-2', userID: 'u-3', role: 'member', displayName: 'Cara', joinedAt: '2026-01-01T00:00:00Z' },
      ]);
      qc.setQueryData(['userConversations'], [
        { conversationID: 'dm-bob', type: 'dm', displayName: 'Bob', participantIDs: ['u-me', 'u-2'] },
        { conversationID: 'dm-cara', type: 'dm', displayName: 'Cara', participantIDs: ['u-me', 'u-3'] },
        { conversationID: 'grp', type: 'group', displayName: 'Bob, Cara', participantIDs: ['u-me', 'u-2', 'u-3'] },
        // A row the server sent without its participants.
        { conversationID: 'dm-legacy', type: 'dm', displayName: 'Someone' },
      ]);
      // Lists still loading have nothing to patch.
      void qc.prefetchQuery({ queryKey: ['users-batch', ['u-9']], queryFn: () => new Promise(() => undefined) });
      void qc.prefetchQuery({ queryKey: ['channelMembers', 'ch-9'], queryFn: () => new Promise(() => undefined) });
    }
    const status = { emoji: ':palm_tree:', text: 'On holiday' };

    it('a status change reaches every copy of the user without a single request', () => {
      const { qc } = renderAt('/', seed);
      const spy = vi.spyOn(qc, 'invalidateQueries');
      const untouchedBatch = qc.getQueryData(['users-batch', ['u-3']]);
      (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-2', userStatus: status, timeZone: 'Europe/Berlin' });

      expect(spy).not.toHaveBeenCalled();
      expect(qc.getQueryData(['user', 'u-2'])).toMatchObject({ userStatus: status, timeZone: 'Europe/Berlin' });
      expect(qc.getQueryData<{ id: string; userStatus?: unknown }[]>(['users-batch', ['u-2', 'u-3']])?.[0]).toMatchObject({ userStatus: status });
      expect(qc.getQueryData(['users-batch', ['u-3']])).toBe(untouchedBatch);
      expect(qc.getQueryData<{ userStatus?: unknown }[]>(['allUsers'])?.[0].userStatus).toEqual(status);
      expect(qc.getQueryData<{ userStatus?: unknown }[]>(['searchUsers', 'bo'])?.[0].userStatus).toEqual(status);
      expect(qc.getQueryData<{ userStatus?: unknown }[]>(['users-directory', ''])?.[0].userStatus).toEqual(status);
      const convs = qc.getQueryData<{ conversationID: string; userStatus?: unknown }[]>(['userConversations'])!;
      expect(convs.find((c) => c.conversationID === 'dm-bob')?.userStatus).toEqual(status);
      expect(convs.find((c) => c.conversationID === 'dm-cara')?.userStatus).toBeUndefined();

      // The sweeper clearing it again.
      (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-2', userStatus: null, timeZone: 'Europe/Berlin' });
      expect(qc.getQueryData<{ userStatus?: unknown }>(['user', 'u-2'])?.userStatus).toBeUndefined();
      expect(qc.getQueryData<{ conversationID: string; userStatus?: unknown }[]>(['userConversations'])?.[0].userStatus).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    });

    it('a rename or new avatar patches the lists and refetches only the conversations showing the user', () => {
      const { qc } = renderAt('/', seed);
      const spy = vi.spyOn(qc, 'invalidateQueries');
      const otherChannel = qc.getQueryData(['channelMembers', 'ch-2']);
      (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-2', displayName: 'Bobby', avatarURL: '/media/bobby.webp' });

      expect(qc.getQueryData<{ displayName: string; avatarURL?: string }[]>(['users-batch', ['u-2', 'u-3']])?.[0]).toMatchObject({
        displayName: 'Bobby',
        avatarURL: '/media/bobby.webp',
      });
      expect(qc.getQueryData<{ displayName: string }[]>(['allUsers'])?.[0].displayName).toBe('Bobby');
      expect(qc.getQueryData<{ displayName: string }[]>(['channelMembers', 'ch-1'])?.map((m) => m.displayName)).toEqual(['Bobby', 'Cara']);
      expect(qc.getQueryData(['channelMembers', 'ch-2'])).toBe(otherChannel);
      expect(spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey)).toEqual([['userConversations']]);

      // An avatar removed ("") falls back to the initials.
      (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-2', avatarURL: '' });
      expect(qc.getQueryData<{ avatarURL?: string }>(['user', 'u-2'])?.avatarURL).toBeUndefined();
    });

    it('a time-zone change touches no conversation row', () => {
      const { qc } = renderAt('/', seed);
      const convs = qc.getQueryData(['userConversations']);
      const spy = vi.spyOn(qc, 'invalidateQueries');
      (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-2', timeZone: 'Asia/Tokyo' });
      expect(qc.getQueryData(['userConversations'])).toBe(convs);
      expect(qc.getQueryData<{ timeZone?: string }>(['user', 'u-2'])?.timeZone).toBe('Asia/Tokyo');
      expect(spy).not.toHaveBeenCalled();
    });

    it('a profile change for someone in no cached conversation refetches nothing', () => {
      const { qc } = renderAt('/', seed);
      const spy = vi.spyOn(qc, 'invalidateQueries');
      (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-7', displayName: 'Dee', status: 'deactivated', lastSeenAt: '2026-05-03T10:00:00.000Z' });
      expect(spy).not.toHaveBeenCalled();
      expect(qc.getQueryData(['user', 'u-7'])).toBeUndefined();
    });

    it('a status change for someone with no DM, or with no conversations loaded, changes no conversation', () => {
      const { qc } = renderAt('/', seed);
      const convs = qc.getQueryData(['userConversations']);
      (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-me', userStatus: status });
      expect(qc.getQueryData(['userConversations'])).toBe(convs);
      qc.removeQueries({ queryKey: ['userConversations'] });
      const spy = vi.spyOn(qc, 'invalidateQueries');
      (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-2', displayName: 'Bobby' });
      expect(spy).not.toHaveBeenCalled();
    });

    it('no longer broadcasts the old ex:user-updated window event', () => {
      renderAt('/', seed);
      const listener = vi.fn();
      window.addEventListener('ex:user-updated', listener);
      try {
        (capturedOptions.onUserUpdated as (d: unknown) => void)({ id: 'u-2', displayName: 'Bobby' });
      } finally {
        window.removeEventListener('ex:user-updated', listener);
      }
      expect(listener).not.toHaveBeenCalled();
    });
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
    expectInvalidPayloadReported('notification.settings_updated', () =>
      (capturedOptions.onNotificationSettingsUpdated as (d: unknown) => void)({}),
    );
    // Nor partial settings: they would replace the user's whole settings.
    expectInvalidPayloadReported('notification.settings_updated', () =>
      (capturedOptions.onNotificationSettingsUpdated as (d: unknown) => void)({ settings: { desktopLevel: 'all' } }),
    );
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
    expectInvalidPayloadReported('attachment.deleted', () => (capturedOptions.onAttachmentDeleted as (d: unknown) => void)({}));
    expect(() => (capturedOptions.onAttachmentDeleted as (d: unknown) => void)({ id: 'a-1' })).not.toThrow();
  });

  // The delivery contract: a notification.new the backend sent is an alert
  // the user must get, so a payload with fields the client doesn't expect —
  // extra, missing or mistyped ones it doesn't need — still dispatches.
  it('onNotification dispatches a payload with unexpected, extra and missing optional fields', () => {
    renderAt('/');
    (capturedOptions.onNotification as (d: unknown) => void)({
      kind: 'catchup',
      parentID: 'ch-1',
      title: 7,
      messageID: { not: 'a string' },
      parentUnreadNotifyCount: 'three',
      someFutureField: ['x'],
    });
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification).toHaveBeenCalledWith({
      kind: 'catchup',
      parentID: 'ch-1',
      parentType: 'channel',
      title: '',
      body: '',
      deepLink: '',
      someFutureField: ['x'],
    });
  });

  it('onNotification reports a payload it cannot route instead of dropping it quietly', () => {
    renderAt('/');
    expectInvalidPayloadReported('notification.new', () =>
      (capturedOptions.onNotification as (d: unknown) => void)({ title: 'no kind, no parent' }),
    );
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it('refetches what an unreadable userchannel, emoji or activity frame would have patched', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    expectInvalidPayloadReported(
      ['userchannel.updated', 'emoji.added', 'emoji.removed', 'activity.new', 'activity.read'],
      () => {
        (capturedOptions.onUserChannelUpdated as (d: unknown) => void)({ channelID: 42 });
        (capturedOptions.onEmojiAdded as (d: unknown) => void)({ name: 'no-image' });
        (capturedOptions.onEmojiRemoved as (d: unknown) => void)({});
        (capturedOptions.onActivityNew as (d: unknown) => void)({ item: { id: 'a1' } });
        (capturedOptions.onActivityRead as (d: unknown) => void)({ ids: 'a1' });
      },
    );
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(keys).toEqual([
      ['userChannels'],
      ['userConversations'],
      ['sidebarCategories'],
      ['userState'],
      ['emojis'],
      ['emojis'],
      ['activity'],
      ['activity'],
    ]);
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

  describe('unread: the "New messages" line, holds, mark-unread events', () => {
    const seed = (unreadCount: number) => (qc: QueryClient) => {
      qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', channelName: 'general', unreadCount }]);
      qc.setQueryData(['userConversations'], [{ conversationID: 'dm-1', type: 'dm', displayName: 'Me' }]);
    };
    const arrive = (over: Record<string, unknown>) =>
      act(() => (capturedOptions.onMessageNew as (d: unknown) => void)(msg({ parentType: 'channel', ...over })));
    afterEach(() => {
      for (const key of ['ch-1', 'dm-1', threadReadKey('msg-root')]) endReadSession(key);
    });

    it('an unseen arrival in the open chat starts the line there — only if it is the first unread', () => {
      isActiveChannel.mockReturnValue(true);
      forceAwayUntilInput();
      renderAt('/', seed(0));
      arrive({ id: 'msg-first' });
      expect(bumpChannelUnread).toHaveBeenCalled();
      expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'message', messageID: 'msg-first' });

      endReadSession('ch-1');
      renderAt('/', seed(3));
      arrive({ id: 'msg-later' });
      expect(getUnreadAnchor('ch-1')).toBeUndefined();
    });

    it('a list opened on older history counts the arrival for its pill instead of drawing a line', () => {
      isActiveChannel.mockReturnValue(true);
      renderAt('/', seed(0));
      setAtLiveTail('ch-1', false);
      const missed = renderHook(() => useMissedArrivals('ch-1'));
      arrive({ id: 'msg-unseen' });
      expect(bumpChannelUnread).toHaveBeenCalled();
      expect(missed.result.current).toBe(1);
      expect(getUnreadAnchor('ch-1')).toBeUndefined();
      missed.unmount();
    });

    it('a chat you are not in gets a badge but no line', () => {
      renderAt('/', seed(0));
      arrive({ id: 'msg-elsewhere' });
      expect(bumpChannelUnread).toHaveBeenCalled();
      expect(getUnreadAnchor('ch-1')).toBeUndefined();
    });

    it('scrolled up, or held unread: an arrival in the open chat stays unread', () => {
      isActiveChannel.mockReturnValue(true);
      renderAt('/', seed(0));
      setAtBottom('ch-1', false);
      arrive({ id: 'msg-below' });
      setAtBottom('ch-1', true);
      holdRead('ch-1');
      arrive({ id: 'msg-held' });
      expect(bumpChannelUnread).toHaveBeenCalledTimes(2);
      expect(apiFetch).not.toHaveBeenCalledWith('/api/v1/channels/ch-1/read', { method: 'PUT' });
    });

    it('your own post ends a hold (channel and conversation), since posting reads the chat', () => {
      renderAt('/', seed(2));
      holdRead('ch-1');
      arrive({ id: 'mine-1', authorID: 'u-me' });
      expect(isReadHeld('ch-1')).toBe(false);
      expect(clearChannelUnreadInCache).toHaveBeenCalledWith(expect.anything(), 'ch-1');

      holdRead('dm-1');
      arrive({ id: 'mine-2', authorID: 'u-me', parentID: 'dm-1', parentType: 'conversation' });
      expect(isReadHeld('dm-1')).toBe(false);
      expect(clearConversationUnreadInCache).toHaveBeenCalledWith(expect.anything(), 'dm-1');
    });

    it('a thread held unread is not marked seen by arrivals; your own reply ends the hold', () => {
      isActiveThread.mockReturnValue(true);
      renderAt('/', seed(0));
      holdRead(threadReadKey('msg-root'));
      arrive({ id: 'reply-1', parentMessageID: 'msg-root' });
      expect(apiFetch).not.toHaveBeenCalledWith('/api/v1/user-state/threads/channels/ch-1/msg-root/seen', { method: 'PUT' });
      arrive({ id: 'reply-2', parentMessageID: 'msg-root', authorID: 'u-me' });
      expect(isReadHeld(threadReadKey('msg-root'))).toBe(false);
    });

    it('a reply alert for a thread held unread keeps it unread', () => {
      isActiveThread.mockReturnValue(true);
      renderAt('/', seed(0));
      holdRead(threadReadKey('msg-root'));
      act(() => (capturedOptions.onNotification as (d: unknown) => void)({
        kind: 'thread_reply', parentID: 'ch-1', parentType: 'channel', parentMessageID: 'msg-root', createdAt: '2026-05-01T10:00:01Z',
      }));
      expect(markThreadNotificationUnread).toHaveBeenCalledWith('msg-root');
    });

    it('marked unread on another device: the row is refetched, not cleared', () => {
      const { qc } = renderAt('/', seed(0));
      const spy = vi.spyOn(qc, 'invalidateQueries');
      act(() => (capturedOptions.onUserChannelUpdated as (d: unknown) => void)({ channelID: 'ch-1', unread: true }));
      act(() => (capturedOptions.onUserChannelUpdated as (d: unknown) => void)({ conversationID: 'dm-1', unread: true }));
      expect(spy).toHaveBeenCalledWith({ queryKey: ['userChannels'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['userConversations'] });
      expect(clearChannelUnreadInCache).not.toHaveBeenCalled();
      expect(clearConversationUnreadInCache).not.toHaveBeenCalled();
    });
  });
});

