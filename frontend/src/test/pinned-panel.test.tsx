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
