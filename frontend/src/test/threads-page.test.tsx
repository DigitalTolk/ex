import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ThreadsPage from '@/pages/ThreadsPage';
import type { ThreadSummary } from '@/hooks/useThreads';

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
  useUserConversations: () => ({
    data: [{ conversationID: 'conv-1', type: 'dm', displayName: 'Bob' }],
  }),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-me', displayName: 'Me' } }),
}));

// Stub ThreadCard so this test focuses on the page-level orchestration:
// one card per summary, correct title and deep-link, empty state, loading.
// ThreadCard's own behavior (snippet rendering, collapse, reply composer)
// is covered in thread-card.test.tsx.
vi.mock('@/components/threads/ThreadCard', () => ({
  ThreadCard: ({ summary, title, deepLink }: { summary: ThreadSummary; title: string; deepLink: string }) => (
    <article
      data-testid="thread-card"
      data-thread-root-id={summary.threadRootID}
      data-deep-link={deepLink}
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

  it('resets the threads page scroll position to the top on mount', async () => {
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
      expect(scrollAssignments).toContain(0);
    } finally {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, 'scrollTop', descriptor);
      } else {
        delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
      }
    }
  });
});
