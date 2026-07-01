import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// A second, mock-divergent counterpart to ChatPage.browser.test.tsx.
// vi.mock is per-file, so this file pins different collaborator
// behaviour (isActiveConversation → true, a self-only/empty user,
// draft-event suppression) to drive the WS-router branch arms the
// primary file structurally cannot reach with its always-false mocks.

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout" style={{ minHeight: 10, minWidth: 10, background: '#fff' }}>
      {children}
      <span>app-layout-ready</span>
    </div>
  ),
}));

const mockMarkThreadNotificationUnread = vi.fn();
const mockUnhideConversation = vi.fn();
const {
  bumpChannelUnread: mockBumpChannelUnread,
  bumpConversationUnread: mockBumpConversationUnread,
  clearConversationUnreadInCache: mockClearConversationUnreadInCache,
} = vi.hoisted(() => ({
  bumpChannelUnread: vi.fn(),
  bumpConversationUnread: vi.fn(),
  clearConversationUnreadInCache: vi.fn(),
}));
vi.mock('@/lib/unread-cache', () => ({
  bumpChannelUnread: mockBumpChannelUnread,
  bumpConversationUnread: mockBumpConversationUnread,
  clearConversationUnreadInCache: mockClearConversationUnreadInCache,
}));
const isActiveConversationMock = vi.fn(() => true);
const isActiveChannelMock = vi.fn(() => false);

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadThreadNotifications: new Set(),
    hiddenConversations: new Set(),
    markThreadNotificationUnread: mockMarkThreadNotificationUnread,
    hideConversation: vi.fn(),
    unhideConversation: mockUnhideConversation,
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: isActiveChannelMock,
    isActiveConversation: isActiveConversationMock,
    setActiveThread: vi.fn(),
    isActiveThread: vi.fn(() => false),
  }),
  UnreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false, setUserOnline: vi.fn() }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// A user reference the tests can swap so the `user?.id ?? null`
// fallback arms (null) run on at least one render.
const userRef = vi.hoisted(() => ({
  value: { id: 'u-1', displayName: 'Test', email: 't@t.com', systemRole: 'member', status: 'active' } as
    | { id: string; displayName: string; email: string; systemRole: string; status: string }
    | null,
}));
const mockPatchUser = vi.fn();
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: userRef.value,
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    patchUser: mockPatchUser,
    setAuth: vi.fn(),
  }),
}));

const mockDispatchNotification = vi.fn();
vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => ({ dispatch: mockDispatchNotification, setCurrentUserID: vi.fn() }),
}));

vi.mock('@/context/TypingContext', () => ({
  useTyping: () => ({ recordTyping: vi.fn(), clearTyping: vi.fn(), setSelfUserID: vi.fn() }),
}));

// Heavy cache helpers are no-ops here — we assert on the router
// branch decisions, not the cache mutations they delegate to.
const mockMarkThreadSeen = vi.hoisted(() => vi.fn());
const mockUserThreadInCache = vi.hoisted(() => vi.fn((..._args: unknown[]) => false));
vi.mock('@/hooks/useMessages', () => ({
  appendMessageToCache: vi.fn(),
  invalidateThreadBothScopes: vi.fn(),
  invalidateUnfurlsForMessage: vi.fn(),
  markMessageDeletedInCache: vi.fn(),
  patchMessageInThreadCache: vi.fn(),
  resyncMessageCache: vi.fn().mockResolvedValue(undefined),
  updateMessageInCache: vi.fn(),
}));
vi.mock('@/hooks/useThreads', () => ({
  markThreadSeen: mockMarkThreadSeen,
  useUserThreads: () => ({ data: [], isSuccess: true, isError: false }),
  upsertUserThreadFromRoot: vi.fn(),
  userThreadInCache: (...args: unknown[]) => mockUserThreadInCache(...args),
}));

const shouldRefetchRef = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/useDrafts', () => ({
  shouldRefetchDraftsForRemoteUpdate: () => shouldRefetchRef.value,
  useDrafts: () => ({ data: [], isSuccess: true, isError: false }),
}));

const mockApiFetch = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockUseWebSocket = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: unknown) => { mockUseWebSocket(opts); },
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

import ChatPage from './ChatPage';

const originalMatchMedia = window.matchMedia;
function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
}

type WsHandlers = Record<string, ((data?: unknown) => void) | undefined>;
function lastHandlers(): WsHandlers {
  return mockUseWebSocket.mock.calls.at(-1)?.[0] as WsHandlers;
}

async function renderChatPage(initialPath = '/', seedCache = true, seedThreads?: unknown[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedCache) {
    qc.setQueryData(['userChannels'], [{ channelID: 'ch-99', channelName: 'general' }]);
    qc.setQueryData(['userConversations'], [{ conversationID: 'conv-1' }]);
  }
  if (seedThreads) {
    qc.setQueryData(['userThreads'], seedThreads);
  }
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <ChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function msg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1', parentID: 'ch-99', parentType: 'channel', authorID: 'other-user',
    body: 'hi', createdAt: '2026-04-30T10:00:00Z', ...overrides,
  };
}

describe('ChatPage WS router — divergent-mock branch arms (browser)', () => {
  beforeEach(() => {
    mockUseWebSocket.mockClear();
    mockBumpChannelUnread.mockClear();
    mockBumpConversationUnread.mockClear();
    mockUnhideConversation.mockClear();
    mockClearConversationUnreadInCache.mockClear();
    mockDispatchNotification.mockClear();
    mockMarkThreadNotificationUnread.mockClear();
    mockMarkThreadSeen.mockClear();
    mockUserThreadInCache.mockClear();
    mockUserThreadInCache.mockReturnValue(false);
    mockApiFetch.mockClear();
    navigateMock.mockClear();
    isActiveConversationMock.mockReturnValue(true);
    isActiveChannelMock.mockReturnValue(false);
    shouldRefetchRef.value = true;
    userRef.value = { id: 'u-1', displayName: 'Test', email: 't@t.com', systemRole: 'member', status: 'active' };
    setMobileViewport(false);
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true, writable: true, value: originalMatchMedia,
    });
  });

  it('onMessageNew on an ACTIVE conversation clears unread and PUTs the read marker', async () => {
    await renderChatPage();
    lastHandlers().onMessageNew?.(msg({ parentID: 'conv-1', parentType: 'conversation' }));
    expect(mockClearConversationUnreadInCache).toHaveBeenCalledWith(expect.anything(), "conv-1");
    await vi.waitFor(() => {
      const call = mockApiFetch.mock.calls.find((c) => String(c[0]).includes('/conversations/conv-1/read'));
      expect(call).toBeDefined();
    });
    // The active conversation is NOT unhidden (author is not self and it is active).
    expect(mockUnhideConversation).not.toHaveBeenCalled();
  });

  it('onMessageNew on the ACTIVE channel PUTs the read marker instead of marking unread', async () => {
    isActiveChannelMock.mockReturnValue(true);
    await renderChatPage();
    lastHandlers().onMessageNew?.(msg({ parentID: 'ch-99', parentType: 'channel', authorID: 'other-user' }));
    expect(mockBumpChannelUnread).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const call = mockApiFetch.mock.calls.find((c) => String(c[0]).includes('/channels/ch-99/read'));
      expect(call).toBeDefined();
    });
  });

  it('onMessageNew for a conversation THREAD reply does not mark or clear DM unread', async () => {
    // The new conversation gate mirrors channels: a thread-only reply is not
    // new DM activity, so neither markConversationUnread nor the active-read
    // path runs.
    await renderChatPage();
    lastHandlers().onMessageNew?.(msg({
      parentID: 'conv-1', parentType: 'conversation', parentMessageID: 'root-1', authorID: 'other-user',
    }));
    expect(mockBumpConversationUnread).not.toHaveBeenCalled();
    expect(mockClearConversationUnreadInCache).not.toHaveBeenCalled();
  });

  it('onMessageNew marks a non-active conversation unread for a top-level message', async () => {
    isActiveConversationMock.mockReturnValue(false);
    await renderChatPage();
    lastHandlers().onMessageNew?.(msg({
      parentID: 'conv-1', parentType: 'conversation', authorID: 'other-user',
    }));
    expect(mockBumpConversationUnread).toHaveBeenCalledWith(expect.anything(), "conv-1");
  });

  it('onMessageNew unhides an active conversation when the author is the local user', async () => {
    await renderChatPage();
    lastHandlers().onMessageNew?.(msg({ parentID: 'conv-1', parentType: 'conversation', authorID: 'u-1' }));
    expect(mockUnhideConversation).toHaveBeenCalledWith('conv-1');
  });

  it('onMessageNew marks the active thread seen with a conversation parentType', async () => {
    await renderChatPage('/?thread=root-1');
    lastHandlers().onMessageNew?.(msg({
      parentID: 'conv-1', parentType: 'conversation', parentMessageID: 'root-1', authorID: 'u-1',
    }));
    expect(mockMarkThreadSeen).toHaveBeenCalledWith('root-1', '2026-04-30T10:00:00Z', {
      parentID: 'conv-1', parentType: 'conversation',
    });
  });

  it('onMessageNew falls back to empty caches when no query data is seeded', async () => {
    await renderChatPage('/', false);
    // userChannels / userConversations getQueryData return undefined → `?? []`.
    expect(() => lastHandlers().onMessageNew?.(msg({ parentType: undefined }))).not.toThrow();
  });

  it('onMessageEdited keys the thread invalidation off the message id when no parentMessageID', async () => {
    await renderChatPage();
    // Full valid message, no parentMessageID → `parentMessageID || id` uses id.
    expect(() => lastHandlers().onMessageEdited?.(msg())).not.toThrow();
  });

  it('onChannelArchived navigates home when the archived channel is the open one', async () => {
    history.replaceState({}, '', '/channel/general');
    try {
      await renderChatPage();
      // window.location.pathname ends with /channel/<slug of "general"> → the
      // navigate('/', {replace:true}) branch fires.
      lastHandlers().onChannelArchived?.({ channelID: 'ch-99' });
      await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    } finally {
      history.replaceState({}, '', '/');
    }
  });

  it('onChannelRemoved navigates home when the removed channel is the open one', async () => {
    history.replaceState({}, '', '/channel/general');
    try {
      await renderChatPage();
      lastHandlers().onChannelRemoved?.({ channelID: 'ch-99' });
      await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    } finally {
      history.replaceState({}, '', '/');
    }
  });

  it('onAttachmentDeleted accepts a valid { id } payload', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onAttachmentDeleted?.({ id: 'att-1' })).not.toThrow();
    expect(() => lastHandlers().onAttachmentDeleted?.({})).not.toThrow();
  });

  it('onUserUpdated patches self with a non-null status object', async () => {
    await renderChatPage();
    lastHandlers().onUserUpdated?.({ id: 'u-1', userStatus: { emoji: ':wave:', text: 'hi' } });
    expect(mockPatchUser).toHaveBeenCalled();
  });

  it('onUserUpdated patches self with only a timeZone (no userStatus key)', async () => {
    await renderChatPage();
    // No `userStatus` property → hasOwnProperty(...) false → the `: {}` arm,
    // and the timeZone-present arm contributes the patched field.
    lastHandlers().onUserUpdated?.({ id: 'u-1', timeZone: 'Europe/Berlin' });
    expect(mockPatchUser).toHaveBeenCalledWith(expect.objectContaining({ timeZone: 'Europe/Berlin' }));
  });

  it('onNotification dispatches a top-level channel alert without touching the unread cache', async () => {
    await renderChatPage();
    // A top-level channel notification.new is just the alert (popup/sound). The
    // sidebar badge rides the separate message.new event (list-cache patch +
    // durable-inbox replay), so the notification handler must NOT mark unread.
    lastHandlers().onNotification?.({
      kind: 'message', parentID: 'ch-99', parentType: 'channel', createdAt: '2026-05-01T00:00:00Z',
    });
    expect(mockBumpChannelUnread).not.toHaveBeenCalled();
    expect(mockDispatchNotification).toHaveBeenCalled();
  });

  it('onNotification marks the active thread seen for a conversation-parent thread reply', async () => {
    await renderChatPage('/?thread=root-1');
    lastHandlers().onNotification?.({
      kind: 'thread_reply', parentMessageID: 'root-1', parentID: 'conv-1',
      parentType: 'conversation', createdAt: '2026-05-01T00:00:00Z',
    });
    expect(mockMarkThreadSeen).toHaveBeenCalledWith('root-1', '2026-05-01T00:00:00Z', {
      parentID: 'conv-1', parentType: 'conversation',
    });
  });

  it('onNotification skips the /threads refetch when the thread is already in the cache (patched, not re-read)', async () => {
    mockUserThreadInCache.mockReturnValue(true);
    await renderChatPage('/', true, [
      { parentID: 'ch-99', parentType: 'channel', threadRootID: 'root-9', rootAuthorID: 'me', rootBody: 'hi', rootCreatedAt: '2026-05-01T00:00:00Z', replyCount: 1, latestActivityAt: '2026-05-01T00:01:00Z' },
    ]);
    mockApiFetch.mockClear();
    // Thread already patched into /threads → the fallback refetch must not fire
    // (it would re-run the race-prone read and could clobber the patched row).
    expect(() =>
      lastHandlers().onNotification?.({
        kind: 'thread_reply', parentMessageID: 'root-9', parentID: 'ch-99',
        parentType: 'channel', createdAt: '2026-05-01T00:02:00Z',
      }),
    ).not.toThrow();
    expect(mockUserThreadInCache).toHaveBeenCalledWith(expect.anything(), 'root-9');
    // No /threads re-read was issued for the already-cached thread.
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/threads');
  });

  it('onDraftUpdated returns early while local mutations are still suppressed', async () => {
    shouldRefetchRef.value = false;
    await renderChatPage();
    expect(() => lastHandlers().onDraftUpdated?.({ parentID: 'ch-99' })).not.toThrow();
  });

  it('onServerVersion drops a payload missing the version field', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onServerVersion?.({})).not.toThrow();
    expect(() => lastHandlers().onServerVersion?.({ version: 'v9.9.9' })).not.toThrow();
  });

  it('clears the current-user id wiring when no user is present', async () => {
    userRef.value = null;
    await renderChatPage();
    // user?.id ?? null → null path runs in the effect; the hook is disabled.
    expect(lastHandlers().enabled).toBe(false);
  });
});
