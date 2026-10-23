import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import ChatPage from '@/pages/ChatPage';
import { PresenceProvider } from '@/context/PresenceContext';
import { TypingProvider } from '@/context/TypingContext';
import { usePresenceStore } from '@/stores/presence';
import { recordTyping } from '@/stores/typing';

// ChatPage is the root of the signed-in app: everything (the layout, top
// bar, account menu, banners, tab bar, the phone's ready gate) renders below
// it. It writes presence and typing; it must not subscribe to them, or every
// presence flip and typing ping anywhere in the workspace re-rendered the
// whole tree.

const layout = vi.hoisted(() => ({ renders: 0 }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: ReactNode }) => {
    layout.renders++;
    return <div data-testid="layout">{children}</div>;
  },
}));
vi.mock('@/components/chat/RunActivityDrawer', () => ({ RunActivityDrawer: () => null }));
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string) => (path === '/api/v1/presence' ? { online: ['u-2'] } : [])),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-me', email: 'me@example.com', displayName: 'Me', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
    patchUser: vi.fn(),
  }),
}));
vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    isActiveChannel: () => false,
    isActiveConversation: () => false,
    markThreadNotificationUnread: vi.fn(),
    isActiveThread: () => false,
    unhideConversation: vi.fn(),
  }),
}));
vi.mock('@/context/NotificationContext', () => ({
  useNotifications: () => ({ dispatch: vi.fn(), notifyApproval: vi.fn(), setCurrentUserID: vi.fn() }),
}));

describe('ChatPage render scope', () => {
  it('does not re-render the app shell for presence or typing events', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PresenceProvider>
          <TypingProvider>
            <MemoryRouter initialEntries={['/']}>
              <Routes>
                <Route path="/*" element={<ChatPage />} />
              </Routes>
            </MemoryRouter>
          </TypingProvider>
        </PresenceProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('layout')).toBeInTheDocument();
    // The presence backfill lands (and is the last thing that may render).
    await waitFor(() => expect(usePresenceStore.getState().online.has('u-2')).toBe(true));
    const settled = layout.renders;

    act(() => {
      usePresenceStore.getState().setUserOnline('u-3', true);
      usePresenceStore.getState().setUserOnline('u-2', false);
    });
    act(() => {
      recordTyping('ch-1', 'u-3');
      recordTyping('ch-1', 'u-4', 'root-1');
    });
    expect(layout.renders).toBe(settled);
  });
});
