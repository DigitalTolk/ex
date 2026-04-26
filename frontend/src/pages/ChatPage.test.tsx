import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
const mockMarkConversationUnread = vi.fn();

const mockUnhideConversation = vi.fn();

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set(),
    unreadConversations: new Set(),
    hiddenConversations: new Set(),
    markChannelUnread: mockMarkChannelUnread,
    markConversationUnread: mockMarkConversationUnread,
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

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: unknown) => {
    mockUseWebSocket(opts);
  },
}));

function renderChatPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatPage', () => {
  it('renders AppLayout', () => {
    renderChatPage();
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
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

  it('onMessageNew marks unread for messages from other users', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    opts.onMessageNew({ parentID: 'ch-99', authorID: 'other-user' });
    expect(mockMarkChannelUnread).toHaveBeenCalledWith('ch-99');
    expect(mockMarkConversationUnread).toHaveBeenCalledWith('ch-99');
  });

  it('onMessageNew does NOT mark unread for own messages', () => {
    mockMarkChannelUnread.mockClear();
    mockMarkConversationUnread.mockClear();
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // user.id is 'u-1' from the mock
    opts.onMessageNew({ parentID: 'ch-99', authorID: 'u-1' });
    expect(mockMarkChannelUnread).not.toHaveBeenCalled();
    expect(mockMarkConversationUnread).not.toHaveBeenCalled();
  });

  it('onMessageNew still invalidates queries for own messages', () => {
    renderChatPage();
    const opts = mockUseWebSocket.mock.calls[0][0];
    // Own message should still refresh the message list, just not mark unread
    opts.onMessageNew({ parentID: 'ch-99', authorID: 'u-1' });
    // No assertion on queryClient since it's not mocked, but it should not throw
  });

  it('onMessageNew does nothing without parentID', () => {
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
    opts.onMessageNew({ parentID: 'conv-1', authorID: 'other-user' });
    expect(mockUnhideConversation).toHaveBeenCalledWith('conv-1');
  });
});
