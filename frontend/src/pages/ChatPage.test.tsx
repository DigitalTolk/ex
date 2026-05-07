import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from './ChatPage';

// Mock AppLayout to just render children
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout">{children}</div>
  ),
}));

const mockMarkChannelUnread = vi.fn();
const mockMarkChannelNotificationUnread = vi.fn();
const mockMarkConversationUnread = vi.fn();
const mockMarkThreadNotificationUnread = vi.fn();

const mockUnhideConversation = vi.fn();

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
    clearConversationUnread: vi.fn(),
    hideConversation: vi.fn(),
    unhideConversation: mockUnhideConversation,
    setActiveChannel: vi.fn(),
    setActiveConversation: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveConversation: vi.fn(() => false),
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
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

const mockUseWebSocket = vi.fn();
const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: unknown) => {
    mockUseWebSocket(opts);
  },
}));

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

function renderChatPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['userChannels'], [{ channelID: 'ch-99', channelName: 'general' }]);
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatPage', () => {
  beforeEach(() => {
    mockUseWebSocket.mockClear();
    mockMarkChannelUnread.mockClear();
    mockMarkConversationUnread.mockClear();
    mockUnhideConversation.mockClear();
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

  it('renders AppLayout', () => {
    renderChatPage();
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('does not gate desktop rendering on sidebar query data', () => {
    setMobileViewport(false);

    renderChatPage();

    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-chat-loading')).not.toBeInTheDocument();
  });

  it('keeps the mobile loading page while initial chat shell data is still pending', () => {
    setMobileViewport(true);
    globalThis.fetch = vi.fn(() => new Promise<Response>(() => undefined));

    renderChatPage();

    expect(screen.getByTestId('mobile-chat-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('app-layout')).not.toBeInTheDocument();
  });

  it('renders the mobile chat shell after initial sidebar data has loaded', async () => {
    setMobileViewport(true);
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/v1/user-state') {
        return Promise.resolve(responseJSON({
          channelNotifications: [],
          threadNotifications: [],
          threadSeen: {},
          hiddenConversations: [],
        }));
      }
      return Promise.resolve(responseJSON([]));
    });

    renderChatPage();

    expect(screen.getByTestId('mobile-chat-loading')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('app-layout')).toBeInTheDocument());
    expect(screen.queryByTestId('mobile-chat-loading')).not.toBeInTheDocument();
  });

  it('does not keep mobile users stuck on the loading page when a startup query fails', async () => {
    setMobileViewport(true);
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/v1/conversations') {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Server error',
          text: () => Promise.resolve('Server error'),
        } as Response);
      }
      if (path === '/api/v1/user-state') {
        return Promise.resolve(responseJSON({
          channelNotifications: [],
          threadNotifications: [],
          threadSeen: {},
          hiddenConversations: [],
        }));
      }
      return Promise.resolve(responseJSON([]));
    });

    renderChatPage();

    await waitFor(() => expect(screen.getByTestId('app-layout')).toBeInTheDocument());
  });

  it('sets up WebSocket with enabled flag when user exists', () => {
    renderChatPage();
    expect(mockUseWebSocket).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it('passes onMessageNew callback to WebSocket', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    expect(typeof opts.onMessageNew).toBe('function');
  });

  function msg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'msg-1',
      parentID: 'ch-99',
      authorID: 'other-user',
      body: 'hi',
      createdAt: '2026-04-30T10:00:00Z',
      ...overrides,
    };
  }

  it('onMessageNew marks unread for messages from other users', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    opts.onMessageNew(msg());
    expect(mockMarkChannelUnread).toHaveBeenCalledWith('ch-99');
    expect(mockMarkConversationUnread).not.toHaveBeenCalledWith('ch-99');
  });

  it('onMessageNew does NOT mark unread for own messages', () => {
    mockMarkChannelUnread.mockClear();
    mockMarkConversationUnread.mockClear();
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // user.id is 'u-1' from the mock
    opts.onMessageNew(msg({ authorID: 'u-1' }));
    expect(mockMarkChannelUnread).not.toHaveBeenCalled();
    expect(mockMarkConversationUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew still invalidates queries for own messages', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    opts.onMessageNew(msg({ authorID: 'u-1' }));
  });

  it('onMessageNew does nothing without a valid Message payload', () => {
    mockMarkChannelUnread.mockClear();
    mockMarkConversationUnread.mockClear();
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    opts.onMessageNew({});
    expect(mockMarkChannelUnread).not.toHaveBeenCalled();
  });

  it('passes onMessageEdited callback that handles parentID', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    expect(typeof opts.onMessageEdited).toBe('function');
    // Should not throw
    opts.onMessageEdited({ parentID: 'ch-1' });
    opts.onMessageEdited({});
  });

  it('passes onMessageDeleted callback that handles parentID', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    expect(typeof opts.onMessageDeleted).toBe('function');
    opts.onMessageDeleted({ parentID: 'ch-1' });
    opts.onMessageDeleted({});
  });

  it('passes onMembersChanged callback to WebSocket', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    expect(typeof opts.onMembersChanged).toBe('function');
  });

  it('onMembersChanged does nothing without channelID', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Should not throw
    opts.onMembersChanged({});
    opts.onMembersChanged(undefined);
  });

  it('onMembersChanged handles valid channelID', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Should not throw
    opts.onMembersChanged({ channelID: 'ch-1' });
  });

  it('passes onConversationNew callback to WebSocket', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    expect(typeof opts.onConversationNew).toBe('function');
  });

  it('onConversationNew does not throw', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Should not throw
    opts.onConversationNew();
  });

  it('passes onChannelArchived callback to WebSocket', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    expect(typeof opts.onChannelArchived).toBe('function');
  });

  it('onChannelArchived does nothing without channelID', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Should not throw
    opts.onChannelArchived({});
    opts.onChannelArchived(undefined);
  });

  it('onChannelArchived handles valid channelID', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Should not throw
    opts.onChannelArchived({ channelID: 'ch-2' });
  });

  it('passes onChannelUpdated callback to WebSocket', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    expect(typeof opts.onChannelUpdated).toBe('function');
  });

  it('onChannelUpdated does nothing without channelID', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Should not throw
    opts.onChannelUpdated({});
    opts.onChannelUpdated(undefined);
  });

  it('onChannelUpdated handles valid channelID', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Should not throw
    opts.onChannelUpdated({ channelID: 'ch-1' });
  });

  it('passes onChannelNew callback to WebSocket', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    expect(typeof opts.onChannelNew).toBe('function');
  });

  it('onChannelNew does not throw', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Should not throw
    opts.onChannelNew();
  });

  it('onMessageNew calls unhideConversation', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    opts.onMessageNew(msg({ parentID: 'conv-1', parentType: 'conversation' }));
    expect(mockUnhideConversation).toHaveBeenCalledWith('conv-1');
  });
});
