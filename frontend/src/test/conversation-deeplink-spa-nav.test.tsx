import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  Link,
  useNavigate,
} from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConversationView } from '@/components/chat/ConversationView';
import type { Conversation } from '@/types';

// Pins down the network behaviour the user has been reporting issues
// with: clicking a DM result from /search must seed the message list
// with `?around=<anchor>` as the FIRST request — never start the
// window with `?after=` from a half-cached page. Same goes for moving
// between two anchors in the same conversation — each anchor gets its
// own around-fetch instead of recycling the cache. Plus a coverage
// test that the around-window's top-level messages still render even
// when interleaved with thread replies (replies belong to the thread
// panel, not the main list, but they must not crowd visible messages
// out of the page budget).

const conversation: Conversation = {
  id: 'conv-1',
  type: 'dm',
  name: 'Chat with Bob',
  participantIDs: ['u-1', 'u-2'],
  createdAt: '2026-01-01T00:00:00Z',
};

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', displayName: 'Alice', email: 'a@a.com', systemRole: 'member', status: 'active' },
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    setAuth: vi.fn(),
  }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({
    unreadChannels: new Set(),
    unreadConversations: new Set(),
    markChannelUnread: vi.fn(),
    markConversationUnread: vi.fn(),
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

vi.mock('@/hooks/useConversations', () => ({
  useConversation: () => ({ data: conversation }),
  useUserConversations: () => ({ data: [] }),
  useSearchUsers: () => ({ data: [] }),
  useCreateConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: vi.fn(),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
  // Default catch-all so unrelated component fetches (users-batch,
  // emojis, etc.) don't throw during render. Specific tests override
  // this with mockImplementation.
  apiFetchMock.mockResolvedValue({ items: [], hasMoreOlder: false, hasMoreNewer: false });
});

function NavigateButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button data-testid="nav-btn" onClick={() => navigate(to)}>
      go
    </button>
  );
}

describe('ConversationView — SPA navigation with deep-link anchor', () => {
  it('seeds the message list with ?around=<anchor> when navigated to /conversation/X#msg-Y from another route (the /search → DM hop)', async () => {
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/conversations/conv-1/messages')) {
        // Return SOME data so the query settles. The point of the test
        // is to assert *which* URL fires first, not what comes back.
        return Promise.resolve({
          items: [
            { id: 'msg-anchor', parentID: 'conv-1', authorID: 'u-1', body: 'anchor', createdAt: '2026-01-01T00:00:00Z' },
          ],
          hasMoreOlder: false,
          hasMoreNewer: false,
          oldestID: 'msg-anchor',
          newestID: 'msg-anchor',
        });
      }
      // Anything else (users-batch, etc.)
      return Promise.resolve([]);
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/search?q=hello']}>
          <Routes>
            <Route
              path="/search"
              element={
                <Link to="/conversation/conv-1#msg-anchor" data-testid="search-result-link">
                  go to DM
                </Link>
              }
            />
            <Route path="/conversation/:id" element={<ConversationView />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Sanity: we're on the /search route first.
    expect(screen.getByTestId('search-result-link')).toBeInTheDocument();

    // Click the search-result link to SPA-navigate to the DM with an
    // anchor. fireEvent runs synchronously inside act so React commits
    // the navigation before we inspect the network calls.
    await act(async () => {
      screen.getByTestId('search-result-link').click();
    });

    // Wait for the conversation messages query to fire.
    await waitFor(() => {
      const conversationMessageCalls = apiFetchMock.mock.calls.filter((c) =>
        String(c[0]).startsWith('/api/v1/conversations/conv-1/messages'),
      );
      expect(conversationMessageCalls.length).toBeGreaterThan(0);
    });

    const conversationMessageCalls = apiFetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.startsWith('/api/v1/conversations/conv-1/messages'));

    // The FIRST messages-call must be the around-fetch — not an
    // ?after= or ?cursor= request that would have started from a
    // half-cached page.
    const firstCall = conversationMessageCalls[0];
    expect(firstCall).toContain('around=anchor');
    expect(firstCall).not.toContain('after=');
    expect(firstCall).not.toContain('cursor=');
  });

  it('seeds the message list with ?around=<anchor> when navigating between two different anchors in the same conversation (/conversation/X#msg-A → /conversation/X#msg-B)', async () => {
    // A second deep-link click in the same conversation must produce
    // its own ?around=B fetch. If the cached pages from anchor A leak
    // into the anchor-B query, the user lands on the wrong window.
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/conversations/conv-1/messages')) {
        return Promise.resolve({
          items: [
            { id: 'm', parentID: 'conv-1', authorID: 'u-1', body: 'x', createdAt: '2026-01-01T00:00:00Z' },
          ],
          hasMoreOlder: false,
          hasMoreNewer: false,
        });
      }
      return Promise.resolve([]);
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/conversation/conv-1#msg-a']}>
          <Routes>
            <Route
              path="/conversation/:id"
              element={
                <>
                  <ConversationView />
                  <NavigateButton to="/conversation/conv-1#msg-b" />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      const calls = apiFetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith('/api/v1/conversations/conv-1/messages'));
      expect(calls.length).toBeGreaterThan(0);
    });

    const firstWaveCount = apiFetchMock.mock.calls.filter((c) =>
      String(c[0]).startsWith('/api/v1/conversations/conv-1/messages'),
    ).length;

    await act(async () => {
      screen.getByTestId('nav-btn').click();
    });

    await waitFor(() => {
      const calls = apiFetchMock.mock.calls.filter((c) =>
        String(c[0]).startsWith('/api/v1/conversations/conv-1/messages'),
      );
      expect(calls.length).toBeGreaterThan(firstWaveCount);
    });

    const secondWaveCalls = apiFetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.startsWith('/api/v1/conversations/conv-1/messages'))
      .slice(firstWaveCount);

    // The second-wave call(s) for messages must include an around=b
    // request — not just an ?after= continuation of the first window.
    expect(secondWaveCalls.some((u) => u.includes('around=b'))).toBe(true);
  });

  // The "thread replies don't consume the page budget" guarantee
  // lives at the helper layer now: `buildMessageListRows` filters
  // replies before Virtuoso ever sees them. See the dedicated test
  // for that filtering in `message-list-day-divider.test.tsx`.
});
