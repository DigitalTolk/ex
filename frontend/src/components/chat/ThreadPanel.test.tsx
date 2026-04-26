import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ThreadPanel } from './ThreadPanel';
import type { Message } from '@/types';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockReplyMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSendMessage: () => ({ mutate: mockReplyMutate, isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

const userMap = {
  'u-1': { displayName: 'Alice', avatarURL: 'https://x/a.png' },
  'u-2': { displayName: 'Bob' },
};

const replies: Message[] = [
  {
    id: 'r-1',
    parentID: 'ch-1',
    parentMessageID: 'm-1',
    authorID: 'u-2',
    body: 'reply one',
    createdAt: '2026-04-24T10:30:00Z',
  },
];

describe('ThreadPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiFetch.mockReset();
  });

  it('renders thread header and replies', async () => {
    mockApiFetch.mockResolvedValueOnce(replies);
    renderWithProviders(
      <ThreadPanel
        channelId="ch-1"
        threadRootID="m-1"
        onClose={vi.fn()}
        userMap={userMap}
        currentUserId="u-1"
      />,
    );

    expect(screen.getByText('Thread')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('reply one')).toBeInTheDocument();
    });
  });

  it('calls onClose when close button is clicked', () => {
    mockApiFetch.mockResolvedValueOnce([]);
    const onClose = vi.fn();
    renderWithProviders(
      <ThreadPanel
        channelId="ch-1"
        threadRootID="m-1"
        onClose={onClose}
        userMap={userMap}
        currentUserId="u-1"
      />,
    );
    fireEvent.click(screen.getByLabelText('Close thread'));
    expect(onClose).toHaveBeenCalled();
  });

  it('sends a reply via parentMessageID', async () => {
    mockApiFetch.mockResolvedValueOnce([]); // initial GET
    mockApiFetch.mockResolvedValueOnce({ id: 'new', body: 'hi', authorID: 'u-1', createdAt: '', parentID: 'ch-1' }); // POST
    const user = userEvent.setup();
    renderWithProviders(
      <ThreadPanel
        channelId="ch-1"
        threadRootID="m-1"
        onClose={vi.fn()}
        userMap={userMap}
        currentUserId="u-1"
      />,
    );

    const textarea = await screen.findByLabelText('Message input');
    await user.type(textarea, 'hello in thread');
    await user.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(mockReplyMutate).toHaveBeenCalledWith({
        body: 'hello in thread',
        attachmentIDs: [],
        parentMessageID: 'm-1',
      });
    });
  });

  it('shows empty state when there are no replies', async () => {
    mockApiFetch.mockResolvedValueOnce([]);
    renderWithProviders(
      <ThreadPanel
        conversationId="conv-1"
        threadRootID="m-1"
        onClose={vi.fn()}
        userMap={userMap}
        currentUserId="u-1"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/no replies yet/i)).toBeInTheDocument();
    });
  });
});
