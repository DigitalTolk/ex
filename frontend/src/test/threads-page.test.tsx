import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    localStorage.clear();
  });

  it('renders thread rows with parent label and reply count', async () => {
    apiFetchMock.mockResolvedValueOnce(sample);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    expect(screen.getByText('#general')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('3 replies')).toBeInTheDocument();
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  it('shows an empty state when no threads exist', async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('threads-empty')).toBeInTheDocument();
    });
  });

  it('marks every thread unread when nothing is in the seen map', async () => {
    apiFetchMock.mockResolvedValueOnce(sample);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-unread')).toHaveLength(2);
    });
  });

  it('drops the unread dot once a thread has been seen at-or-after its latest activity', async () => {
    localStorage.setItem(
      'ex.threads.seen.v1',
      JSON.stringify({ 'msg-root-1': '2026-04-26T11:00:01Z' }),
    );
    apiFetchMock.mockResolvedValueOnce(sample);
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByTestId('thread-row')).toHaveLength(2);
    });
    // Only the conv thread should still be unread (msg-root-2 has no seen entry).
    expect(screen.getAllByTestId('thread-unread')).toHaveLength(1);
  });

  it('navigates to channel?thread=… when a channel thread row is clicked', async () => {
    apiFetchMock.mockResolvedValueOnce(sample);
    renderPage();
    const rows = await screen.findAllByTestId('thread-row');
    fireEvent.click(rows[0]);
    expect(screen.getByTestId('channel-page')).toBeInTheDocument();
  });
});
