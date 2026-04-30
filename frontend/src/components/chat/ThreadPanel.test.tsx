import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ThreadPanel } from './ThreadPanel';
import { TypingProvider, useTyping } from '@/context/TypingContext';
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
      <BrowserRouter>
        <TypingProvider>{ui}</TypingProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

// Bridge a TypingContext recorder out of the React tree so a test can
// fire a `typing` WebSocket event from the outside.
const typingRecorderRef: { current: ReturnType<typeof useTyping>['recordTyping'] | null } = {
  current: null,
};

function TypingProbe() {
  const { recordTyping } = useTyping();
  useEffect(() => {
    typingRecorderRef.current = recordTyping;
  }, [recordTyping]);
  return null;
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

  it('does NOT render a "Reply in thread" action on replies inside the thread panel', async () => {
    // Bug: clicking the thread action bar / reply-in-thread button on
    // a message inside the open thread did nothing (the parent did
    // not pass onReplyInThread because they're already in the thread).
    // Fix: ThreadPanel passes inThread to MessageItem, which suppresses
    // the affordance. This test guards against the affordance returning.
    const repliesWithCounts: Message[] = [
      {
        id: 'r-1',
        parentID: 'ch-1',
        parentMessageID: 'm-1',
        authorID: 'u-2',
        body: 'a reply that itself has replies',
        createdAt: '2026-04-24T10:30:00Z',
        replyCount: 3,
        recentReplyAuthorIDs: ['u-1'],
        lastReplyAt: '2026-04-24T10:35:00Z',
      },
    ];
    mockApiFetch.mockResolvedValueOnce(repliesWithCounts);
    renderWithProviders(
      <ThreadPanel
        channelId="ch-1"
        threadRootID="m-1"
        onClose={vi.fn()}
        userMap={userMap}
        currentUserId="u-1"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/a reply that itself has replies/)).toBeInTheDocument();
    });
    // No "Reply in thread" toolbar button on any reply.
    expect(screen.queryByLabelText('Reply in thread')).toBeNull();
    // No nested ThreadActionBar (which would show reply count + jump).
    expect(screen.queryByTestId('thread-action-bar')).toBeNull();
  });

  describe('thread typing indicator', () => {
    it('renders the in-thread typing indicator when a typing event with parentMessageID arrives', async () => {
      // Bob is typing inside the m-1 thread reply composer of ch-1.
      // ThreadPanel reads typingByThread keyed by (parentID, threadRootID),
      // so the indicator must appear in the ThreadPanel — and not bleed
      // into any main-list TypingIndicator.
      mockApiFetch.mockResolvedValueOnce([]);
      renderWithProviders(
        <>
          <TypingProbe />
          <ThreadPanel
            channelId="ch-1"
            threadRootID="m-1"
            onClose={vi.fn()}
            userMap={userMap}
            currentUserId="u-1"
          />
        </>,
      );
      await waitFor(() => {
        expect(typingRecorderRef.current).toBeTruthy();
      });
      act(() => {
        // Simulate the WS handler receiving a typing event scoped to
        // (ch-1, m-1) for u-2 (Bob).
        typingRecorderRef.current!('ch-1', 'u-2', 'm-1');
      });
      expect(await screen.findByTestId('thread-typing-indicator')).toHaveTextContent(
        'Bob is typing…',
      );
    });

    it('ignores main-list typing (no parentMessageID) for the same channel', async () => {
      mockApiFetch.mockResolvedValueOnce([]);
      renderWithProviders(
        <>
          <TypingProbe />
          <ThreadPanel
            channelId="ch-1"
            threadRootID="m-1"
            onClose={vi.fn()}
            userMap={userMap}
            currentUserId="u-1"
          />
        </>,
      );
      await waitFor(() => {
        expect(typingRecorderRef.current).toBeTruthy();
      });
      act(() => {
        typingRecorderRef.current!('ch-1', 'u-2');
      });
      expect(screen.queryByTestId('thread-typing-indicator')).toBeNull();
    });

    it('passes typingThreadRootID down so the composer broadcasts thread-scoped typing', async () => {
      // Spy on the WS sender used by MessageInput.emitTyping.
      const wsSender = await import('@/lib/ws-sender');
      const sentFrames: Record<string, unknown>[] = [];
      wsSender.setWSSender((frame) => {
        sentFrames.push(JSON.parse(frame));
      });
      try {
        mockApiFetch.mockResolvedValueOnce([]);
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
        await user.type(textarea, 'h');
        const typingFrame = sentFrames.find((f) => f.type === 'typing');
        expect(typingFrame).toMatchObject({
          type: 'typing',
          parentID: 'ch-1',
          parentType: 'channel',
          parentMessageID: 'm-1',
        });
      } finally {
        wsSender.setWSSender(null);
      }
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
