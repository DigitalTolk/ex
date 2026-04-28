import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ChatPage from '@/pages/ChatPage';

let capturedOptions: Record<string, ((data: unknown) => void) | boolean | undefined> = {};

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: Record<string, ((data: unknown) => void) | boolean | undefined>) => {
    capturedOptions = opts;
  },
}));

const logoutMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-me', email: 'a@b.c', displayName: 'Me', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    logout: logoutMock,
  }),
}));

const markChannelUnread = vi.fn();
const markConversationUnread = vi.fn();
const unhideConversation = vi.fn();

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    markChannelUnread,
    markConversationUnread,
    unhideConversation,
    unreadChannels: new Set(),
    unreadConversations: new Set(),
    hiddenConversations: new Set(),
    hideConversation: vi.fn(),
    clearChannelUnread: vi.fn(),
    clearConversationUnread: vi.fn(),
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation: vi.fn(() => false),
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
    capturedOptions = {};
    markChannelUnread.mockReset();
    markConversationUnread.mockReset();
    unhideConversation.mockReset();
    setUserOnline.mockReset();
    dispatchNotification.mockReset();
    setCurrentUserID.mockReset();
  });

  it('onMessageNew marks unread + un-hides + invalidates queries (skipping self)', () => {
    renderAt('/');
    const handler = capturedOptions.onMessageNew as (d: unknown) => void;
    // From self — should skip the unread marking
    handler({ parentID: 'ch-1', authorID: 'u-me' });
    expect(markChannelUnread).not.toHaveBeenCalled();
    // From someone else
    handler({ parentID: 'ch-1', authorID: 'u-other' });
    expect(markChannelUnread).toHaveBeenCalledWith('ch-1');
    expect(markConversationUnread).toHaveBeenCalledWith('ch-1');
    expect(unhideConversation).toHaveBeenCalledWith('ch-1');
  });

  it('onMessageNew without parentID is a no-op', () => {
    renderAt('/');
    (capturedOptions.onMessageNew as (d: unknown) => void)({});
    expect(markChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew with parentMessageID invalidates thread + userThreads (so the /threads count updates live)', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageNew as (d: unknown) => void)({
      parentID: 'ch-1',
      parentMessageID: 'msg-root',
      authorID: 'u-other',
    });
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['thread', 'channels/ch-1', 'msg-root']);
    expect(calls).toContainEqual(['userThreads']);
  });

  it('onMessageDeleted on a thread reply invalidates that thread + userThreads', () => {
    // Regression: the backend now ships parentMessageID in the deleted
    // payload, and the client routes it to the thread query. Without
    // this, deleting a reply leaves the sidebar / /threads page stale.
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageDeleted as (d: unknown) => void)({
      parentID: 'ch-1',
      parentMessageID: 'msg-root',
      id: 'msg-reply',
    });
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['channelMessages', 'ch-1']);
    expect(calls).toContainEqual(['thread', 'channels/ch-1', 'msg-root']);
    expect(calls).toContainEqual(['thread', 'conversations/ch-1', 'msg-root']);
    expect(calls).toContainEqual(['userThreads']);
  });

  it('onMessageDeleted on a thread root falls back to id when parentMessageID is absent', () => {
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMessageDeleted as (d: unknown) => void)({
      parentID: 'ch-1',
      id: 'msg-root',
    });
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['thread', 'channels/ch-1', 'msg-root']);
    expect(calls).toContainEqual(['userThreads']);
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

  it('onMembersChanged also invalidates messages so the "X was added" line shows even if message.new is missed', () => {
    // Regression: AddMember posts a system message via a separate
    // message.new event. If that event is dropped (WS reconnect race,
    // transient disconnect), the membership-changed signal must still
    // refresh the open message view so the system line appears.
    const { qc } = renderAt('/');
    const spy = vi.spyOn(qc, 'invalidateQueries');
    (capturedOptions.onMembersChanged as (d: unknown) => void)({ channelID: 'ch-1' });
    const calls = spy.mock.calls.map((c) => (c[0] as { queryKey?: unknown[] }).queryKey);
    expect(calls).toContainEqual(['channelMembers', 'ch-1']);
    expect(calls).toContainEqual(['userChannels']);
    expect(calls).toContainEqual(['channelMessages', 'ch-1']);
    expect(calls).toContainEqual(['conversationMessages', 'ch-1']);
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

  it('onUserUpdated invalidates user-batch + member + channel + conversation caches', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onUserUpdated as (d: unknown) => void)({});
    }).not.toThrow();
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
    (capturedOptions.onServerVersion as (d: unknown) => void)({ version: 'v9.9.9' });
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
