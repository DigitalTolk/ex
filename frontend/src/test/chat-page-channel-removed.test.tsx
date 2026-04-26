import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ChatPage from '@/pages/ChatPage';

let capturedOptions: Record<string, ((data: unknown) => void) | boolean | undefined> = {};

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (opts: Record<string, ((data: unknown) => void) | boolean | undefined>) => {
    capturedOptions = opts;
  },
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'a@b.c', displayName: 'Alice', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    markChannelUnread: vi.fn(),
    markConversationUnread: vi.fn(),
    unhideConversation: vi.fn(),
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

vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({
    online: new Set<string>(),
    isOnline: () => false,
    setUserOnline: vi.fn(),
  }),
  PresenceProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({ data: [] }),
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

function renderAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/*" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatPage - channel removed/archived', () => {
  beforeEach(() => {
    capturedOptions = {};
  });

  it('exposes onChannelRemoved handler', () => {
    renderAt('/');
    expect(typeof capturedOptions.onChannelRemoved).toBe('function');
  });

  it('exposes onChannelArchived handler', () => {
    renderAt('/');
    expect(typeof capturedOptions.onChannelArchived).toBe('function');
  });

  it('onChannelRemoved invokes without throwing for known channelID', () => {
    renderAt('/');
    expect(() => {
      (capturedOptions.onChannelRemoved as (data: unknown) => void)({ channelID: 'ch-1' });
    }).not.toThrow();
  });

  it('exposes onChannelMuted handler', () => {
    renderAt('/');
    expect(typeof capturedOptions.onChannelMuted).toBe('function');
    expect(() => {
      (capturedOptions.onChannelMuted as (data: unknown) => void)({ channelID: 'ch-1', muted: true });
    }).not.toThrow();
  });

  it('exposes onNotification handler that tolerates unknown payloads', () => {
    renderAt('/');
    expect(typeof capturedOptions.onNotification).toBe('function');
    expect(() => {
      (capturedOptions.onNotification as (data: unknown) => void)(undefined);
      (capturedOptions.onNotification as (data: unknown) => void)({});
      (capturedOptions.onNotification as (data: unknown) => void)({
        kind: 'message',
        title: 't',
        body: 'b',
        deepLink: '/channel/x',
        parentID: 'ch-1',
        parentType: 'channel',
        createdAt: new Date().toISOString(),
      });
    }).not.toThrow();
  });
});
