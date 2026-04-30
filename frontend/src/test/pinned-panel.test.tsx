import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PinnedPanel } from '@/components/chat/PinnedPanel';
import type { Message } from '@/types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <PinnedPanel
          channelId="ch-1"
          channelSlug="general"
          onClose={vi.fn()}
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          currentUserId="u-me"
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('PinnedPanel', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('queries the channel pinned endpoint and renders pinned messages', async () => {
    const messages: Message[] = [
      {
        id: 'm-1', parentID: 'ch-1', authorID: 'u-1', body: 'pinned one',
        createdAt: '2026-04-26T10:00:00Z', pinned: true,
      },
    ];
    apiFetchMock.mockResolvedValueOnce(messages);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('pinned one')).toBeInTheDocument();
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/channels/ch-1/pinned');
  });

  it('shows an empty state when nothing is pinned', async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByTestId('pinned-empty')).toBeInTheDocument();
    });
  });

  it('queries the conversation endpoint when conversationId is supplied', async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <PinnedPanel
            conversationId="conv-9"
            onClose={vi.fn()}
            userMap={{}}
            currentUserId="u-me"
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(apiFetchMock).toHaveBeenCalledWith('/api/v1/conversations/conv-9/pinned');
    });
  });

  it('navigates to the message when a pinned row is clicked', async () => {
    const messages: Message[] = [
      {
        id: 'm-pin-1', parentID: 'ch-1', authorID: 'u-1', body: 'pinned',
        createdAt: '2026-04-26T10:00:00Z', pinned: true,
      },
    ];
    apiFetchMock.mockResolvedValueOnce(messages);
    renderPanel();
    const row = await screen.findByTestId('pinned-message-row');
    row.click();
    // Hash anchor drives useDeepLinkAnchor to scroll the main list to
    // the pinned message.
    expect(window.location.pathname).toBe('/channel/general');
    expect(window.location.hash).toBe('#msg-m-pin-1');
  });

  it('navigates to a pinned thread reply with ?thread=ROOT so the thread panel opens', async () => {
    // useDeepLinkAnchor only surfaces a threadAnchor (and the host
    // view only swaps Pinned→Thread) when the URL has ?thread=ROOT,
    // so pinned thread replies must encode that — a bare #msg-X
    // would scroll to the reply but never open the thread panel.
    const messages: Message[] = [
      {
        id: 'm-reply', parentID: 'ch-1', parentMessageID: 'm-root',
        authorID: 'u-1', body: 'pinned reply',
        createdAt: '2026-04-26T10:00:00Z', pinned: true,
      },
    ];
    apiFetchMock.mockResolvedValueOnce(messages);
    window.history.replaceState(null, '', '/');
    renderPanel();
    const row = await screen.findByTestId('pinned-message-row');
    row.click();
    expect(window.location.pathname).toBe('/channel/general');
    expect(window.location.search).toBe('?thread=m-root');
    expect(window.location.hash).toBe('#msg-m-reply');
  });

  it('opens a thread when "Reply in thread" is clicked on a pinned row', async () => {
    // Bug: clicking the thread action bar from inside the PinnedPanel
    // did nothing because MessageItem's onReplyInThread callback was
    // never wired through. The fix wires it to the host view's
    // openThread() helper, which closes the pinned panel and opens the
    // thread side panel for that root message.
    const messages: Message[] = [
      {
        id: 'm-pin-1', parentID: 'ch-1', authorID: 'u-1', body: 'pinned',
        createdAt: '2026-04-26T10:00:00Z', pinned: true,
      },
    ];
    apiFetchMock.mockResolvedValueOnce(messages);
    const onReplyInThread = vi.fn();
    // Reset URL state from any earlier test in the file that navigated.
    window.history.replaceState(null, '', '/');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <PinnedPanel
            channelId="ch-1"
            channelSlug="general"
            onClose={vi.fn()}
            userMap={{ 'u-1': { displayName: 'Alice' } }}
            currentUserId="u-me"
            onReplyInThread={onReplyInThread}
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    // Hover the pinned row so the toolbar button reveals.
    const row = await screen.findByTestId('pinned-message-row');
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const replyBtn = await screen.findByLabelText('Reply in thread');
    replyBtn.click();
    expect(onReplyInThread).toHaveBeenCalledWith('m-pin-1');
    // The row's own jump-to-message handler should NOT have fired —
    // clicks on nested interactive elements stay there. (Hash stays
    // empty from this test's POV.)
    expect(window.location.hash).toBe('');
  });

  it('invokes onClose when the close button is clicked', async () => {
    apiFetchMock.mockResolvedValueOnce([]);
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <PinnedPanel
            channelId="ch-1"
            onClose={onClose}
            userMap={{}}
            currentUserId="u-me"
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    const closeBtn = await screen.findByLabelText('Close pinned messages');
    closeBtn.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
