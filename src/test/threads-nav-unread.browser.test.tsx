import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ChatPage from '@/pages/ChatPage';
import { UnreadProvider } from '@/context/UnreadContext';
import { PresenceProvider } from '@/context/PresenceContext';
import { NotificationProvider } from '@/context/NotificationContext';
import { TypingProvider } from '@/context/TypingContext';
import { eventCallbacks, type CapturedWSOptions } from '@/test/ws-frames';

// The Threads entry is bold exactly while the server holds an unread marker
// for one of the user's threads. A thread reply's notification adds nothing
// of its own: the server writes the marker before sending it, and the app
// reloads the user state on it. A notification once lit the entry by itself,
// and when the thread had been read elsewhere in the meantime (on the phone),
// it stayed lit — with nothing new in Threads or Activity — until a restart.

const ws = vi.hoisted(() => ({ options: null as CapturedWSOptions | null }));
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: (options: CapturedWSOptions) => {
    ws.options = options;
  },
}));
vi.mock('@/components/NotificationPermissionBanner', () => ({ NotificationPermissionBanner: () => null }));
vi.mock('@/context/AuthContext', async (importOriginal) => {
  const user = { id: 'u-me', email: 'me@example.test', displayName: 'Me', systemRole: 'member', status: 'active' };
  const auth = () => ({ user, isAuthenticated: true, isLoading: false, login: vi.fn(), logout: vi.fn(), setAuth: vi.fn(), patchUser: vi.fn() });
  return { ...(await importOriginal<typeof import('@/context/AuthContext')>()), useAuth: auth, useOptionalAuth: auth };
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// The server's unread markers and hidden DMs, and how often the user state
// was loaded.
const server = { markers: [] as string[], hidden: [] as string[], userStateLoads: 0 };

function stubFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/auth/token/refresh')) return json({ accessToken: 't' });
    if (url.includes('/api/v1/user-state')) {
      server.userStateLoads++;
      return json({ threadNotifications: server.markers, threadSeen: {}, threadMarkedUnread: {}, hiddenConversations: server.hidden });
    }
    if (url.endsWith('/api/v1/channels')) {
      return json([{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 'member' }]);
    }
    if (url.endsWith('/api/v1/conversations')) {
      return json([{ conversationID: 'dm-1', type: 'dm', displayName: 'Bob', participantIDs: ['u-me', 'u-bob'] }]);
    }
    if (url.includes('/api/v1/threads')) return json({ threads: [] });
    if (url.includes('/api/v1/admin/settings')) return json({ maxUploadBytes: 0, allowedExtensions: [], giphyEnabled: false });
    if (url.includes('/api/v1/presence')) return json({ online: [] });
    return json([]);
  }) as typeof fetch;
}

async function renderHome() {
  stubFetch();
  await render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <UnreadProvider>
        <PresenceProvider>
          <NotificationProvider>
            <TypingProvider>
              <MemoryRouter initialEntries={['/']}>
                <div style={{ height: 800 }}>
                  <Routes>
                    <Route path="/" element={<ChatPage />}>
                      <Route index element={null} />
                    </Route>
                  </Routes>
                </div>
              </MemoryRouter>
            </TypingProvider>
          </NotificationProvider>
        </PresenceProvider>
      </UnreadProvider>
    </QueryClientProvider>,
  );
  await expect.poll(() => document.querySelector('[data-testid="threads-nav-label"]')).not.toBeNull();
  await expect.poll(() => server.userStateLoads).toBeGreaterThan(0);
}

const bold = () => document.querySelector('[data-testid="threads-nav-label"]')!.classList.contains('font-bold');

function threadReply() {
  eventCallbacks(ws.options!).onNotification!({
    kind: 'thread_reply',
    parentID: 'ch-1',
    parentType: 'channel',
    parentMessageID: 'msg-root',
    messageID: 'reply-1',
    title: 'Alice replied',
    body: 'hello',
    createdAt: '2026-10-30T10:00:00Z',
  });
}

const dmRow = () => document.querySelector('[data-testid="conversation-row-dm-1"]');

describe('the Threads entry', () => {
  it('stays plain after a thread reply whose marker the server no longer holds', async () => {
    server.markers = [];
    server.hidden = [];
    await renderHome();
    await expect.poll(dmRow).not.toBeNull();
    expect(bold()).toBe(false);

    // The reloaded user state also hides a DM: once its row is gone, the app
    // has shown everything that reply brought.
    server.hidden = ['dm-1'];
    threadReply();
    await expect.poll(dmRow).toBeNull();
    expect(bold()).toBe(false);
  });

  it('turns bold once the user state brings the reply’s marker', async () => {
    server.markers = [];
    server.hidden = [];
    await renderHome();
    server.markers = ['msg-root'];
    threadReply();
    await expect.poll(bold).toBe(true);
  });
});
