import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import ThreadsPage from '@/pages/ThreadsPage';
import { markThreadSeen, patchListedThread, resetSeenCache, type ThreadPage, type ThreadSummary } from '@/hooks/useThreads';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({
    data: [{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 }],
  }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useOpenDM: () => ({ openDM: vi.fn(), isPending: false }),
  useUserConversations: () => ({
    data: [{ conversationID: 'conv-1', type: 'dm', displayName: 'Bob' }],
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', displayName: 'Me' } }),
}));

const defaultUserState = {
  channelNotifications: [],
  threadNotifications: ['msg-root-1'],
  threadSeen: {},
  hiddenConversations: [],
};
// undefined = the user-state query hasn't resolved yet.
let mockUserStateData: typeof defaultUserState | undefined = defaultUserState;

vi.mock('@/hooks/useUserState', () => ({
  markLocalUserStateWrite: vi.fn(),
  shouldRefetchUserStateForRemoteUpdate: vi.fn(() => true),
  resetUserStateSessionState: vi.fn(),
}));

// Stub ThreadCard so this test focuses on the page-level orchestration:
// one card per summary, correct title and deep-link, empty state, loading.
// ThreadCard's own behavior (snippet rendering, collapse, reply composer)
// is covered in thread-card.test.tsx.
vi.mock('@/components/threads/ThreadCard', () => ({
  ThreadCard: ({
    summary,
    title,
    deepLink,
    unread,
    expanded,
    onExpand,
  }: {
    summary: ThreadSummary;
    title: string;
    deepLink: string;
    unread?: boolean;
    expanded?: boolean;
    onExpand?: () => void;
  }) => (
    <article
      data-testid="thread-card"
      data-thread-root-id={summary.threadRootID}
      data-deep-link={deepLink}
      data-unread={unread ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <span data-testid="thread-card-title">{title}</span>
      <button type="button" data-testid="thread-card-expand" onClick={onExpand}>expand</button>
    </article>
  ),
}));

const sample: ThreadSummary[] = [
  {
    parentID: 'ch-1',
    parentType: 'channel',
    threadRootID: 'msg-root-1',
    rootAuthorID: 'u-me',
    rootBody: 'kicked off a thread',
    rootCreatedAt: '2026-04-26T10:00:00Z',
    replyCount: 3,
    latestActivityAt: '2026-04-26T11:00:00Z',
  },
  {
    parentID: 'conv-1',
    parentType: 'conversation',
    threadRootID: 'msg-root-2',
    rootAuthorID: 'u-other',
    rootBody: 'DM thread',
    rootCreatedAt: '2026-04-25T10:00:00Z',
    replyCount: 1,
    latestActivityAt: '2026-04-25T12:00:00Z',
  },
];

// servePages answers the list requests from `pages`, one per request in
// order, each pointing at the next.
function servePages(...pages: ThreadSummary[][]) {
  apiFetchMock.mockImplementation((url: string) => {
    const match = /^\/api\/v1\/threads(?:\?cursor=r%3A(\d+))?$/.exec(url);
    const i = match?.[1] ? Number(match[1]) : 0;
    const page: ThreadPage = { threads: pages[i] ?? [], nextCursor: i + 1 < pages.length ? `r:${i + 1}` : undefined };
    return Promise.resolve(page);
  });
}

function renderPage(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  if (mockUserStateData) qc.setQueryData(queryKeys.userState(), mockUserStateData);
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/threads']}>
        <Routes>
          <Route
            path="/threads"
            element={
              <>
                <Link to="/threads" data-testid="threads-nav">Threads</Link>
                <ThreadsPage />
              </>
            }
          />
          <Route path="/channel/:id" element={<div data-testid="channel-page" />} />
          <Route path="/conversation/:id" element={<div data-testid="conv-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return qc;
}

const order = () => screen.getAllByTestId('thread-card').map((el) => el.getAttribute('data-thread-root-id'));

describe('ThreadsPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    localStorage.clear();
    resetSeenCache();
    mockUserStateData = defaultUserState;
  });

  it('renders one ThreadCard per summary with the channel/conversation label as title', async () => {
    servePages(sample);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-card')).toHaveLength(2);
    });
    const titles = screen.getAllByTestId('thread-card-title').map((el) => el.textContent);
    expect(titles).toContain('~general');
    expect(titles).toContain('Bob');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/threads');
  });

  // The server lists the unread threads first; with none, that first page is
  // empty and the page goes straight on to the rest.
  it('goes on past an empty first page, and lists a thread once across pages', async () => {
    servePages([], [sample[1]], [sample[1], sample[0]]);
    renderPage();
    await waitFor(() => expect(order()).toEqual(['msg-root-2', 'msg-root-1']));
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/threads?cursor=r%3A1');
    // A thread on two pages (read between them) shows once.
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/threads?cursor=r%3A2');
  });

  it('freezes the list per visit: a live change patches in place, and Threads opened again starts over', async () => {
    servePages(sample);
    const qc = renderPage();
    await waitFor(() => expect(order()).toEqual(['msg-root-1', 'msg-root-2']));

    // A reply lands in the older thread: its card updates, nothing moves.
    act(() => patchListedThread(qc, { ...sample[1], replyCount: 2, latestActivityAt: '2026-04-27T09:00:00Z' }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(order()).toEqual(['msg-root-1', 'msg-root-2']);

    // Opening Threads again (the sidebar link, even while here) reloads it.
    servePages([{ ...sample[0], threadRootID: 'msg-root-3' }, ...sample]);
    act(() => {
      screen.getByTestId('threads-nav').click();
    });
    await waitFor(() => expect(order()).toEqual(['msg-root-3', 'msg-root-1', 'msg-root-2']));
  });

  it('builds correct deep-links for channel vs conversation threads', async () => {
    servePages(sample);
    renderPage();
    const cards = await screen.findAllByTestId('thread-card');
    const links = cards.map((c) => c.getAttribute('data-deep-link'));
    expect(links).toContain('/channel/general?thread=msg-root-1#msg-msg-root-1');
    expect(links).toContain('/conversation/conv-1?thread=msg-root-2#msg-msg-root-2');
  });

  it('marks a card unread from its thread\'s unread marker alone', async () => {
    servePages([...sample, { ...sample[0], threadRootID: 'msg-root-3' }]);
    renderPage();
    const cards = await screen.findAllByTestId('thread-card');
    expect(cards.map((c) => c.getAttribute('data-unread'))).toEqual(['true', 'false', 'false']);
  });

  it('keeps which threads are expanded on the page, so a card scrolled away and back stays open', async () => {
    // The list is virtualized: a card far off screen unmounts, and its own
    // state with it. The page owns "expanded".
    servePages(sample);
    renderPage();
    const [first, second] = await screen.findAllByTestId('thread-card');
    expect(first).toHaveAttribute('data-expanded', 'false');
    act(() => screen.getAllByTestId('thread-card-expand')[0].click());
    expect(screen.getAllByTestId('thread-card')[0]).toHaveAttribute('data-expanded', 'true');
    expect(second).toHaveAttribute('data-expanded', 'false');
  });

  it('falls back to generic titles when a thread parent is no longer in the sidebar', async () => {
    servePages([
      { ...sample[0], parentID: 'ch-gone', threadRootID: 'msg-root-3' },
      { ...sample[1], parentID: 'conv-gone', threadRootID: 'msg-root-4' },
    ]);
    renderPage();
    const titles = (await screen.findAllByTestId('thread-card-title')).map((el) => el.textContent);
    expect(titles).toContain('~channel');
    expect(titles).toContain('Conversation');
  });

  it('renders with no unread threads while the user state is still loading', async () => {
    mockUserStateData = undefined;
    servePages(sample);
    renderPage();
    const cards = await screen.findAllByTestId('thread-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toHaveAttribute('data-unread', 'false');
    }
  });

  it('clears a thread unread state live when the thread is marked seen', async () => {
    const { queryClient } = await import('@/lib/query-client');
    servePages(sample);
    renderPage(queryClient);
    const cards = await screen.findAllByTestId('thread-card');
    expect(cards[0]).toHaveAttribute('data-unread', 'true');
    // Seeing the thread elsewhere (the thread panel) drops its marker.
    act(() => {
      markThreadSeen('msg-root-1', '2026-04-26T12:00:00Z');
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-card')[0]).toHaveAttribute('data-unread', 'false');
    });
    queryClient.clear();
  });

  it('shows an empty state when no threads exist', async () => {
    servePages([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('threads-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('thread-card')).toBeNull();
  });

  it('renders loading skeletons while threads are still being fetched', () => {
    // Never-resolving fetch — first render shows the loading state.
    apiFetchMock.mockReturnValueOnce(new Promise(() => undefined));
    renderPage();
    expect(screen.getByTestId('threads-loading')).toBeInTheDocument();
  });

  it('reads a malformed page as empty', async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);
    renderPage();
    await waitFor(() => expect(screen.getByTestId('threads-empty')).toBeInTheDocument());
  });

  it('does not force the threads page scroll position on mount', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
    const scrollAssignments: number[] = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() {
        return 240;
      },
      set(value) {
        scrollAssignments.push(value);
      },
    });
    try {
      servePages(sample);
      renderPage();
      expect(scrollAssignments).toEqual([]);
    } finally {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', descriptor);
      } else {
        delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
      }
    }
  });
});
