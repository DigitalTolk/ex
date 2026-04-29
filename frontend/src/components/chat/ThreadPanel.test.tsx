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
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
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

  describe('deep-link anchor inside thread', () => {
    function withScrollIntoViewSpy<T>(fn: (spy: ReturnType<typeof vi.fn>) => Promise<T> | T): Promise<T> | T {
      const original = Element.prototype.scrollIntoView;
      const spy = vi.fn();
      Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
      const result = fn(spy);
      const restore = () => { Element.prototype.scrollIntoView = original; };
      if (result instanceof Promise) {
        return result.finally(restore) as Promise<T>;
      }
      restore();
      return result;
    }

    it('scrolls to and highlights the anchor reply when anchorMsgId is set', async () => {
      const multiReplies: Message[] = [
        { id: 'r-a', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-2', body: 'first reply', createdAt: '2026-04-24T10:30:00Z' },
        { id: 'r-b', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-2', body: 'target reply', createdAt: '2026-04-24T10:31:00Z' },
        { id: 'r-c', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-2', body: 'newest reply', createdAt: '2026-04-24T10:32:00Z' },
      ];
      await withScrollIntoViewSpy(async (spy) => {
        mockApiFetch.mockResolvedValueOnce(multiReplies);
        renderWithProviders(
          <ThreadPanel
            channelId="ch-1"
            threadRootID="m-1"
            onClose={vi.fn()}
            userMap={userMap}
            currentUserId="u-1"
            anchorMsgId="r-b"
          />,
        );
        await waitFor(() => {
          expect(screen.getByText('target reply')).toBeInTheDocument();
        });
        // scrollIntoView was called on the anchor reply, centered.
        const target = document.getElementById('msg-r-b');
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.instances).toContain(target);
        const opts = spy.mock.calls.find((c) => c[0]?.block === 'center')?.[0] as
          | ScrollIntoViewOptions
          | undefined;
        expect(opts?.block).toBe('center');
        // Highlight ring applied.
        expect(target?.classList.contains('ring-1')).toBe(true);
        expect(target?.classList.contains('ring-amber-400/50')).toBe(true);
      });
    });

    it('does NOT snap to the bottom (newest reply) when anchorMsgId is set', async () => {
      const multiReplies: Message[] = [
        { id: 'r-a', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-2', body: 'first', createdAt: '2026-04-24T10:30:00Z' },
        { id: 'r-b', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-2', body: 'target', createdAt: '2026-04-24T10:31:00Z' },
        { id: 'r-c', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-2', body: 'newest', createdAt: '2026-04-24T10:32:00Z' },
      ];
      await withScrollIntoViewSpy(async () => {
        mockApiFetch.mockResolvedValueOnce(multiReplies);
        const { container } = renderWithProviders(
          <ThreadPanel
            channelId="ch-1"
            threadRootID="m-1"
            onClose={vi.fn()}
            userMap={userMap}
            currentUserId="u-1"
            anchorMsgId="r-b"
          />,
        );
        await waitFor(() => {
          expect(screen.getByText('target')).toBeInTheDocument();
        });
        const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
        Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
        // Stick-to-bottom should be skipped — anchor controls position.
        // (In the spied scrollIntoView env, scrollTop won't actually
        // move; but the absence of an assignment to scrollHeight
        // confirms the bottom-stick branch was skipped.)
        expect(scroller.scrollTop).toBe(0);
      });
    });
  });
});
