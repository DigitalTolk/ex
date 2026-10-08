import { describe, it, expect, vi } from 'vitest';

// The view-level composer pulls in data hooks this test doesn't stub.
vi.mock('@/components/chat/markdown/MarkdownComposer', () => ({
  MarkdownComposer: () => <textarea aria-label="Message input" />,
}));
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChannelView } from '@/components/chat/ChannelView';
import { endReadSession, noteMissedArrival } from '@/lib/read-position';
import type { Channel } from '@/types';

// A channel opened from a link (search, "jump to message", an alert) shows a
// window of older history. A message arriving meanwhile can't appear in it,
// so the list offers a pill; taking it loads the newest messages in place —
// the URL (and any open ?thread=) is left alone.

const channel: Channel = {
  id: 'ch-1',
  name: 'general',
  slug: 'general',
  type: 'public',
  createdBy: 'u-1',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
};

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' } }),
}));
vi.mock('@/context/UnreadContext', () => ({
  useOptionalUnread: () => undefined,
  useUnread: () => ({
    setActiveChannel: vi.fn(),
    setActiveThread: vi.fn(),
    isActiveChannel: vi.fn(() => false),
    isActiveThread: vi.fn(() => false),
  }),
}));
vi.mock('@/context/PresenceContext', () => ({
  usePresence: () => ({ online: new Set<string>(), isOnline: () => false, setUserOnline: vi.fn() }),
}));
vi.mock('@/hooks/useChannels', () => ({
  useChannelBySlug: () => ({ data: channel, isLoading: false }),
  useChannelMembers: () => ({ data: [] }),
  useUserChannels: () => ({ data: [] }),
  useMuteChannel: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: vi.fn() }));

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

describe('ChannelView — leaving a link-opened window for the newest messages', () => {
  it('the pill loads the newest messages and keeps the URL', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/channels/ch-1/messages')) {
        const linked = url.includes('around=');
        const id = linked ? 'old' : 'new';
        return Promise.resolve({
          items: [{ id, parentID: 'ch-1', authorID: 'u-2', body: id, createdAt: '2026-01-01T00:00:00Z' }],
          hasMoreOlder: false,
          hasMoreNewer: linked,
          oldestID: id,
          newestID: id,
        });
      }
      return Promise.resolve([]);
    });
    function Where() {
      const loc = useLocation();
      return <span data-testid="where">{loc.pathname + loc.hash}</span>;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/channel/general#msg-old']}>
          <Routes>
            <Route path="/channel/:id" element={<><ChannelView /><Where /></>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const messageCalls = () =>
      apiFetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/v1/channels/ch-1/messages'));
    await waitFor(() => expect(messageCalls().some((u) => u.includes('around=old'))).toBe(true));
    await act(async () => noteMissedArrival('ch-1'));
    const pill = await screen.findByTestId('unread-below-pill');
    await act(async () => pill.click());
    await waitFor(() => expect(messageCalls().some((u) => !u.includes('around='))).toBe(true));
    expect(screen.getByTestId('where').textContent).toBe('/channel/general#msg-old');
    await waitFor(() => expect(screen.queryByTestId('unread-below-pill')).toBeNull());
    endReadSession('ch-1');
  });
});
