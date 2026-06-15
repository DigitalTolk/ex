import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ThreadsPage from '@/pages/ThreadsPage';
import { sortThreadsByUnreadThenActivity, unreadThreadIDs, type ThreadSummary } from '@/hooks/useThreads';

const apiFetchMock = vi.fn();
const unreadThreadNotifications = new Set<string>();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useChannels', () => ({
  useUserChannels: () => ({
    data: [{ channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1 }],
  }),
}));

vi.mock('@/hooks/useConversations', () => ({
  useUserConversations: () => ({
    data: [{ conversationID: 'conv-1', type: 'dm', displayName: 'Bob' }],
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', displayName: 'Me' } }),
}));

vi.mock('@/context/UnreadContext', () => ({
  useUnread: () => ({ unreadThreadNotifications }),
}));

vi.mock('@/hooks/useUserState', () => ({
  useUserState: () => ({
    data: {
      channelNotifications: [],
      threadNotifications: ['msg-root-1'],
      threadSeen: {},
      hiddenConversations: [],
    },
  }),
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
  }: {
    summary: ThreadSummary;
    title: string;
    deepLink: string;
    unread?: boolean;
  }) => (
    <article
      data-testid="thread-card"
      data-thread-root-id={summary.threadRootID}
      data-deep-link={deepLink}
      data-unread={unread ? 'true' : 'false'}
    >
      <span data-testid="thread-card-title">{title}</span>
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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/threads']}>
        <Routes>
          <Route path="/threads" element={<ThreadsPage />} />
          <Route path="/channel/:id" element={<div data-testid="channel-page" />} />
          <Route path="/conversation/:id" element={<div data-testid="conv-page" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ThreadsPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    unreadThreadNotifications.clear();
    localStorage.clear();
  });

  it('renders one ThreadCard per summary with the channel/conversation label as title', async () => {
    apiFetchMock.mockResolvedValueOnce(sample);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-card')).toHaveLength(2);
    });
    const titles = screen.getAllByTestId('thread-card-title').map((el) => el.textContent);
    expect(titles).toContain('~general');
    expect(titles).toContain('Bob');
  });

  it('builds correct deep-links for channel vs conversation threads', async () => {
    apiFetchMock.mockResolvedValueOnce(sample);
    renderPage();
    const cards = await screen.findAllByTestId('thread-card');
    const links = cards.map((c) => c.getAttribute('data-deep-link'));
    expect(links).toContain('/channel/general?thread=msg-root-1#msg-msg-root-1');
    expect(links).toContain('/conversation/conv-1?thread=msg-root-2#msg-msg-root-2');
  });

  it('passes unread state to ThreadCard from persisted thread notifications', async () => {
    apiFetchMock.mockResolvedValueOnce(sample);
    renderPage();
    const cards = await screen.findAllByTestId('thread-card');
    expect(cards[0]).toHaveAttribute('data-thread-root-id', 'msg-root-1');
    expect(cards[0]).toHaveAttribute('data-unread', 'true');
    expect(cards[1]).toHaveAttribute('data-thread-root-id', 'msg-root-2');
    expect(cards[1]).toHaveAttribute('data-unread', 'false');
  });

  it('shows unread threads first, then read threads, each by most recent activity', async () => {
    unreadThreadNotifications.add('live-unread-older');
    unreadThreadNotifications.add('live-unread-newer');
    apiFetchMock.mockResolvedValueOnce([
      { ...sample[0], threadRootID: 'read-newest', latestActivityAt: '2026-04-26T13:00:00Z' },
      { ...sample[0], threadRootID: 'live-unread-older', latestActivityAt: '2026-04-26T10:00:00Z' },
      { ...sample[0], threadRootID: 'read-older', latestActivityAt: '2026-04-26T09:00:00Z' },
      { ...sample[0], threadRootID: 'live-unread-newer', latestActivityAt: '2026-04-26T12:00:00Z' },
    ]);
    renderPage();

    const ids = (await screen.findAllByTestId('thread-card')).map((card) =>
      card.getAttribute('data-thread-root-id'),
    );

    expect(ids).toEqual(['live-unread-newer', 'live-unread-older', 'read-newest', 'read-older']);
  });

  it('pages thread cards in as the load-more sentinel scrolls into view', async () => {
    const callbacks: Array<(entries: { isIntersecting: boolean }[]) => void> = [];
    class MockIO {
      // Mirror the real IntersectionObserver signature (callback + options)
      // so the `{ rootMargin }` argument isn't a superfluous trailing arg.
      constructor(
        cb: (entries: { isIntersecting: boolean }[]) => void,
        _options?: IntersectionObserverInit,
      ) {
        callbacks.push(cb);
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    const prev = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = MockIO as unknown as typeof IntersectionObserver;
    try {
      const many = Array.from({ length: 30 }, (_, i) => ({
        ...sample[0],
        threadRootID: `root-${i}`,
        latestActivityAt: `2026-04-26T${String(10 + (i % 12)).padStart(2, '0')}:00:00Z`,
      }));
      apiFetchMock.mockResolvedValueOnce(many);
      renderPage();
      // First page only — not all 30 cards mount up front.
      await waitFor(() => expect(screen.getAllByTestId('thread-card')).toHaveLength(12));
      expect(screen.getByTestId('threads-load-more')).toBeInTheDocument();
      // Sentinel enters the viewport → the next page mounts.
      act(() => callbacks[callbacks.length - 1]([{ isIntersecting: true }]));
      await waitFor(() => expect(screen.getAllByTestId('thread-card')).toHaveLength(24));
    } finally {
      globalThis.IntersectionObserver = prev;
    }
  });

  it('shows an empty state when no threads exist', async () => {
    apiFetchMock.mockResolvedValueOnce([]);
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
      apiFetchMock.mockResolvedValueOnce(sample);
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

  it('derives unread thread IDs from notifications and seen activity', () => {
    const ids = unreadThreadIDs(
      [
        { ...sample[0], threadRootID: 'newer-than-seen', latestActivityAt: '2026-04-26T11:00:00Z' },
        { ...sample[0], threadRootID: 'already-seen', latestActivityAt: '2026-04-26T11:00:00Z' },
        { ...sample[0], threadRootID: 'never-seen', latestActivityAt: '2026-04-26T11:00:00Z' },
        { ...sample[0], threadRootID: 'live-unread', latestActivityAt: '2026-04-26T11:00:00Z' },
      ],
      ['already-seen'],
      new Set(['live-unread', 'orphan-live']),
      {
        'newer-than-seen': '2026-04-26T10:59:00Z',
        'already-seen': '2026-04-26T11:01:00Z',
      },
    );

    expect(ids.has('newer-than-seen')).toBe(true);
    expect(ids.has('already-seen')).toBe(false);
    expect(ids.has('never-seen')).toBe(false);
    expect(ids.has('live-unread')).toBe(true);
    expect(ids.has('orphan-live')).toBe(false);
  });

  it('sorts thread summaries without mutating the source list', () => {
    const threads = [
      { ...sample[0], threadRootID: 'read-new', latestActivityAt: '2026-04-26T13:00:00Z' },
      { ...sample[0], threadRootID: 'unread-old', latestActivityAt: '2026-04-26T10:00:00Z' },
      { ...sample[0], threadRootID: 'unread-new', latestActivityAt: '2026-04-26T12:00:00Z' },
    ];

    expect(sortThreadsByUnreadThenActivity(threads, new Set(['unread-old', 'unread-new'])).map((t) => t.threadRootID))
      .toEqual(['unread-new', 'unread-old', 'read-new']);
    expect(threads.map((t) => t.threadRootID)).toEqual(['read-new', 'unread-old', 'unread-new']);
  });
});
