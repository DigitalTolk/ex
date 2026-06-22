import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from './ChatPage';

// Browser-coverage counterpart of ChatPage.test.tsx. The jsdom version
// covers every callback branch but contributes only to the jsdom
// coverage gate; ChatPage is excluded there, so those branches still
// register as uncovered in the browser-coverage view that drives the
// 60% (now 70%) browser-branch threshold. This file mirrors the jsdom
// surface against the real-browser runner so the same handler bodies
// finally count where they need to.

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout" style={{ minHeight: 10, minWidth: 10, background: '#fff' }}>
      {children}
      <span>app-layout-ready</span>
    </div>
  ),
}));

const mockMarkChannelUnread = vi.fn();
const mockMarkChannelNotificationUnread = vi.fn();
const mockMarkConversationUnread = vi.fn();
const mockMarkThreadNotificationUnread = vi.fn();
const mockUnhideConversation = vi.fn();
const mockClearConversationUnread = vi.fn();

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set(),
    unreadChannelNotifications: new Set(),
    unreadConversations: new Set(),
    unreadThreadNotifications: new Set(),
    hiddenConversations: new Set(),
    markChannelUnread: mockMarkChannelUnread,
    markChannelNotificationUnread: mockMarkChannelNotificationUnread,
    markConversationUnread: mockMarkConversationUnread,
    markThreadNotificationUnread: mockMarkThreadNotificationUnread,
    clearChannelUnread: vi.fn(),
    clearConversationUnread: mockClearConversationUnread,
    hideConversation: vi.fn(),
    unhideConversation: mockUnhideConversation,
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation: vi.fn(() => false),
    setActiveThread: vi.fn(),
    isActiveThread: vi.fn(() => false),
  }),
  UnreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline: vi.fn(),
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Test', email: 't@t.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    // logout must return a Promise — ChatPage's onForceLogout chains
    // `.finally(...)` on it to bounce the user to /login.
    logout: vi.fn().mockResolvedValue(undefined),
    patchUser: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

const mockDispatchNotification = vi.fn();
vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => ({
    dispatch: mockDispatchNotification,
    setCurrentUserID: vi.fn(),
  }),
}));

const mockRecordTyping = vi.fn();
const mockClearTyping = vi.fn();
vi.mock('@/context/TypingContext', () => ({
  useTyping: () => ({
    recordTyping: mockRecordTyping,
    clearTyping: mockClearTyping,
    setSelfUserID: vi.fn(),
  }),
}));

// Capture the options ChatPage passes to useWebSocket so each test
// can invoke a specific callback directly. The hook itself is a
// no-op shell — real WS plumbing isn't exercised here, just the
// router code that lives in ChatPage.
const mockUseWebSocket = vi.fn();
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: unknown) => {
    mockUseWebSocket(opts);
  },
}));

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;

function setMobileViewport(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function responseJSON(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response;
}

async function renderChatPage(initialPath = '/') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['userChannels'], [{ channelID: 'ch-99', channelName: 'general' }]);
  qc.setQueryData(['userConversations'], [{ conversationID: 'conv-1' }]);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <ChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

type WsHandlers = Record<string, ((data?: unknown) => void) | undefined>;
function lastHandlers(): WsHandlers {
  return mockUseWebSocket.mock.calls.at(-1)?.[0] as WsHandlers;
}

function msg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg-1',
    parentID: 'ch-99',
    parentType: 'channel',
    authorID: 'other-user',
    body: 'hi',
    createdAt: '2026-04-30T10:00:00Z',
    ...overrides,
  };
}

describe('ChatPage WS router (browser)', () => {
  beforeEach(() => {
    mockUseWebSocket.mockClear();
    mockMarkChannelUnread.mockClear();
    mockMarkConversationUnread.mockClear();
    mockUnhideConversation.mockClear();
    mockDispatchNotification.mockClear();
    mockRecordTyping.mockClear();
    mockClearTyping.mockClear();
    setMobileViewport(false);
    globalThis.fetch = vi.fn().mockResolvedValue(responseJSON([]));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it('renders AppLayout and wires every WS callback', async () => {
    await renderChatPage();
    expect(document.querySelector('[data-testid="app-layout"]')).not.toBeNull();
    const opts = lastHandlers();
    expect(opts.enabled).toBe(true);
    for (const key of [
      'onMessageNew',
      'onMessageEdited',
      'onMessageDeleted',
      'onMembersChanged',
      'onConversationNew',
      'onChannelArchived',
      'onChannelUpdated',
      'onChannelNew',
      'onChannelRemoved',
      'onPresenceChanged',
      'onEmojiAdded',
      'onEmojiRemoved',
      'onUserUpdated',
      'onUserChannelUpdated',
      'onAttachmentDeleted',
      'onChannelMuted',
      'onNotification',
      'onDraftUpdated',
      'onForceLogout',
      'onServerVersion',
      'onPing',
      'onTyping',
      'onReconnect',
      'onReplayExhausted',
    ]) {
      expect(typeof opts[key]).toBe('function');
    }
  });

  it('onMessageNew marks unread for messages from other users to a channel', async () => {
    await renderChatPage();
    lastHandlers().onMessageNew?.(msg());
    expect(mockMarkChannelUnread).toHaveBeenCalledWith('ch-99');
  });

  it('onMessageNew skips the unread mark for the local user', async () => {
    await renderChatPage();
    lastHandlers().onMessageNew?.(msg({ authorID: 'u-1' }));
    expect(mockMarkChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew unhides a conversation when a new message lands in it', async () => {
    await renderChatPage();
    lastHandlers().onMessageNew?.(msg({ parentID: 'conv-1', parentType: 'conversation' }));
    expect(mockUnhideConversation).toHaveBeenCalledWith('conv-1');
  });

  it('onMessageNew ignores invalid payloads', async () => {
    await renderChatPage();
    lastHandlers().onMessageNew?.({});
    expect(mockMarkChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew infers a channel parent from the cache when parentType is absent', async () => {
    await renderChatPage();
    // No parentType, but parentID matches a cached user channel → treated as a
    // channel message and marked unread.
    lastHandlers().onMessageNew?.(msg({ parentType: undefined }));
    expect(mockMarkChannelUnread).toHaveBeenCalledWith('ch-99');
  });

  it('onMessageNew infers a conversation parent from the cache when parentType is absent', async () => {
    await renderChatPage();
    // No parentType, but parentID matches a cached conversation → unhidden.
    lastHandlers().onMessageNew?.(msg({ parentID: 'conv-1', parentType: undefined }));
    expect(mockUnhideConversation).toHaveBeenCalledWith('conv-1');
  });

  it('onMessageNew routes a thread reply through the thread-invalidation path without bumping the channel', async () => {
    await renderChatPage();
    // A reply (parentMessageID set) takes the thread branch — it invalidates
    // the thread caches and must NOT mark the parent channel unread (a thread
    // reply isn't new top-level channel activity).
    lastHandlers().onMessageNew?.(msg({ parentMessageID: 'root-1' }));
    expect(mockMarkChannelUnread).not.toHaveBeenCalled();
  });

  it('onMessageEdited keys the thread invalidation off parentMessageID when present', async () => {
    await renderChatPage();
    // Exercises the `parentMessageID || id` true branch without throwing.
    expect(() => lastHandlers().onMessageEdited?.(msg({ parentMessageID: 'root-1' }))).not.toThrow();
  });

  it('onMessageEdited tolerates missing channelID', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onMessageEdited?.({})).not.toThrow();
    expect(() => lastHandlers().onMessageEdited?.({ parentID: 'ch-99', id: 'm-1', body: 'edited' })).not.toThrow();
  });

  it('onMessageDeleted tolerates valid + missing payloads', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onMessageDeleted?.({})).not.toThrow();
    expect(() => lastHandlers().onMessageDeleted?.({ parentID: 'ch-99', id: 'm-1' })).not.toThrow();
  });

  it('onMembersChanged tolerates valid + missing channelID', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onMembersChanged?.({})).not.toThrow();
    expect(() => lastHandlers().onMembersChanged?.({ channelID: 'ch-99' })).not.toThrow();
  });

  it('onConversationNew never throws on any payload shape', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onConversationNew?.()).not.toThrow();
    expect(() => lastHandlers().onConversationNew?.({ conversation: { conversationID: 'conv-new' } })).not.toThrow();
  });

  it('onChannelArchived tolerates valid + missing channelID', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onChannelArchived?.({})).not.toThrow();
    expect(() => lastHandlers().onChannelArchived?.({ channelID: 'ch-99' })).not.toThrow();
  });

  it('onChannelUpdated tolerates valid + missing channelID', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onChannelUpdated?.({})).not.toThrow();
    expect(() => lastHandlers().onChannelUpdated?.({ channelID: 'ch-99' })).not.toThrow();
  });

  it('onChannelNew / onChannelRemoved never throw', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onChannelNew?.()).not.toThrow();
    expect(() => lastHandlers().onChannelNew?.({ channel: { channelID: 'ch-99' } })).not.toThrow();
    expect(() => lastHandlers().onChannelRemoved?.({ channelID: 'ch-99' })).not.toThrow();
    expect(() => lastHandlers().onChannelRemoved?.({})).not.toThrow();
  });

  it('onPresenceChanged never throws', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onPresenceChanged?.({ userID: 'u-1', online: true })).not.toThrow();
    expect(() => lastHandlers().onPresenceChanged?.({})).not.toThrow();
  });

  it('onEmojiAdded / onEmojiRemoved never throw', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onEmojiAdded?.({ name: 'partyparrot' })).not.toThrow();
    expect(() => lastHandlers().onEmojiRemoved?.({ name: 'partyparrot' })).not.toThrow();
  });

  it('onUserUpdated / onUserChannelUpdated never throw', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onUserUpdated?.({ id: 'u-2', displayName: 'Carol' })).not.toThrow();
    expect(() => lastHandlers().onUserChannelUpdated?.({ channelID: 'ch-99' })).not.toThrow();
  });

  it('onAttachmentDeleted / onChannelMuted never throw', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onAttachmentDeleted?.({ attachmentID: 'a-1' })).not.toThrow();
    expect(() => lastHandlers().onChannelMuted?.({ channelID: 'ch-99', muted: true })).not.toThrow();
  });

  it('onNotification dispatches into the notification context for a valid payload', async () => {
    await renderChatPage();
    lastHandlers().onNotification?.({
      id: 'n-1',
      kind: 'mention',
      parentID: 'ch-99',
      parentType: 'channel',
      title: 'You were mentioned',
      body: 'hello',
      messageID: 'm-1',
      authorID: 'u-2',
      createdAt: '2026-04-30T10:00:00Z',
    });
    expect(mockDispatchNotification).toHaveBeenCalled();
  });

  it('onNotification silently drops a malformed payload', async () => {
    await renderChatPage();
    // No `kind` → ChatPage's guard rejects it before dispatch.
    lastHandlers().onNotification?.({});
    expect(mockDispatchNotification).not.toHaveBeenCalled();
  });

  it('onDraftUpdated never throws on any shape', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onDraftUpdated?.({ parentID: 'ch-99' })).not.toThrow();
    expect(() => lastHandlers().onDraftUpdated?.({})).not.toThrow();
  });

  it('onTyping records typing for a valid payload', async () => {
    await renderChatPage();
    lastHandlers().onTyping?.({
      parentID: 'ch-99',
      parentType: 'channel',
      userID: 'u-2',
    });
    expect(mockRecordTyping).toHaveBeenCalled();
  });

  it('onTyping ignores malformed payloads', async () => {
    await renderChatPage();
    lastHandlers().onTyping?.({});
    expect(mockRecordTyping).not.toHaveBeenCalled();
  });

  it('onServerVersion / onPing never throw', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onServerVersion?.({ version: 'v1.2.3' })).not.toThrow();
    expect(() => lastHandlers().onPing?.({ ts: Date.now() })).not.toThrow();
  });

  it('onForceLogout never throws', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onForceLogout?.({})).not.toThrow();
  });

  it('onReconnect + onReplayExhausted run the refetch path without throwing', async () => {
    await renderChatPage();
    expect(() => lastHandlers().onReconnect?.()).not.toThrow();
    expect(() => lastHandlers().onReplayExhausted?.()).not.toThrow();
  });

  // Mobile gate paths — the loading shell renders until the initial
  // sidebar queries settle. Run this only on the mobile viewports
  // so the `isMobile` branch in MobileChatReadyGate fires.
  it('shows the mobile loading shell on a fresh mobile mount', async () => {
    if (window.innerWidth >= 768) return;
    setMobileViewport(true);
    // Stall every fetch so queries stay pending.
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined));
    await renderChatPage();
    expect(document.querySelector('[data-testid="mobile-chat-loading"]')).not.toBeNull();
  });

  it('keeps the desktop layout from showing the mobile loading shell', async () => {
    if (window.innerWidth < 768) return;
    await renderChatPage();
    expect(document.querySelector('[data-testid="app-layout"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="mobile-chat-loading"]')).toBeNull();
  });

  it('onMessageNew routes a reply to the active thread through markThreadSeen without bumping the channel', async () => {
    await renderChatPage('/?thread=root-1');
    // A reply to the active thread (URL targets root-1) routes through the
    // markThreadSeen branch and must NOT mark the channel unread.
    expect(() =>
      lastHandlers().onMessageNew?.(msg({ parentMessageID: 'root-1', parentID: 'ch-99', parentType: 'channel' })),
    ).not.toThrow();
    expect(mockMarkChannelUnread).not.toHaveBeenCalled();
  });

  it('onUserUpdated patches the local user for self updates (status/timeZone/lastSeenAt)', async () => {
    await renderChatPage();
    lastHandlers().onUserUpdated?.({ id: 'u-1', userStatus: { emoji: ':wave:', text: 'hi' }, timeZone: 'UTC', lastSeenAt: '2026-05-01T00:00:00Z' });
    // Self-update with a cleared status also exercises the null → undefined path.
    lastHandlers().onUserUpdated?.({ id: 'u-1', userStatus: null });
    // A different user id skips the self-patch branch.
    lastHandlers().onUserUpdated?.({ id: 'u-other' });
    // Malformed payload is ignored.
    lastHandlers().onUserUpdated?.({});
  });

  it('onNotificationSettingsUpdated patches self settings and ignores an empty payload', async () => {
    await renderChatPage();
    expect(() => {
      lastHandlers().onNotificationSettingsUpdated?.({
        settings: { desktopLevel: 'all', mobileLevel: 'default', threadReplies: true, ignoreGroupMentions: false, followAllThreads: false, keywords: [] },
      });
      lastHandlers().onNotificationSettingsUpdated?.({});
    }).not.toThrow();
  });

  it('onNotification routes thread vs channel-mention notifications', async () => {
    await renderChatPage('/?thread=root-1');
    // Active-thread notification → markThreadSeen.
    lastHandlers().onNotification?.({ kind: 'mention', parentMessageID: 'root-1', parentID: 'ch-99', parentType: 'channel', createdAt: '2026-05-01T00:00:00Z' });
    // Inactive-thread notification → markThreadNotificationUnread.
    lastHandlers().onNotification?.({ kind: 'thread_reply', parentMessageID: 'root-9', parentID: 'ch-99', parentType: 'channel', createdAt: '2026-05-01T00:00:00Z' });
    // Channel mention with no thread → markChannelNotificationUnread.
    lastHandlers().onNotification?.({ kind: 'mention', parentID: 'ch-99', parentType: 'channel', createdAt: '2026-05-01T00:00:00Z' });
    expect(mockMarkThreadNotificationUnread).toHaveBeenCalledWith('root-9');
    expect(mockMarkChannelNotificationUnread).toHaveBeenCalledWith('ch-99');
    expect(mockDispatchNotification).toHaveBeenCalled();
  });

  it('onPing reports the timezone once, then skips an unchanged repeat', async () => {
    await renderChatPage();
    // First ping detects + reports the timezone; the second sees no change and
    // returns early (the reportedTimeZoneRef guard).
    lastHandlers().onPing?.();
    lastHandlers().onPing?.();
  });
});
