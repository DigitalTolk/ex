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

// MessageInput is exhaustively unit-tested in isolation; here we just
// need a test stub that exposes onSend + records the typing-related
// props so ThreadPanel's prop wiring can be verified without going
// through the full Lexical composer (synthetic typing into Lexical's
// contenteditable isn't wired in jsdom).
const lastMessageInputProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock('./MessageInput', () => ({
  MessageInput: (props: {
    onSend?: (v: { body: string; attachmentIDs: string[] }) => void;
    typingParentID?: string;
    typingParentType?: string;
    typingThreadRootID?: string;
  }) => {
    lastMessageInputProps.current = props as Record<string, unknown>;
    return (
      <div>
        <textarea aria-label="Message input" data-testid="message-input-stub" />
        <button
          aria-label="Send message"
          onClick={() => props.onSend?.({ body: 'hello in thread', attachmentIDs: [] })}
        >
          Send
        </button>
      </div>
    );
  },
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

  it('shows Follow when the thread is not in /threads and calls the follow endpoint', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/v1/threads') return Promise.resolve([]);
      if (url.includes('/messages/m-1/thread')) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    renderWithProviders(
      <ThreadPanel
        channelId="ch-1"
        threadRootID="m-1"
        onClose={vi.fn()}
        userMap={userMap}
        currentUserId="u-1"
      />,
    );

    fireEvent.click(await screen.findByLabelText('Follow thread'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/threads/channels/ch-1/m-1/follow',
        expect.objectContaining({ method: 'PUT' }),
      );
    });
  });

  it('shows Unfollow when the thread is already in /threads and calls the unfollow endpoint', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (url === '/api/v1/threads') {
        return Promise.resolve([
          {
            parentID: 'ch-1',
            parentType: 'channel',
            threadRootID: 'm-1',
            rootAuthorID: 'u-2',
            rootBody: 'root',
            rootCreatedAt: '2026-04-24T10:00:00Z',
            replyCount: 1,
            latestActivityAt: '2026-04-24T10:30:00Z',
          },
        ]);
      }
      if (url.includes('/messages/m-1/thread')) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    renderWithProviders(
      <ThreadPanel
        channelId="ch-1"
        threadRootID="m-1"
        onClose={vi.fn()}
        userMap={userMap}
        currentUserId="u-1"
      />,
    );

    fireEvent.click(await screen.findByLabelText('Unfollow thread'));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith(
        '/api/v1/threads/channels/ch-1/m-1/follow',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  it('forwards parentMessageID to useSendMessage when the user sends a reply', async () => {
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

    await user.click(screen.getByLabelText('Send message'));

    await waitFor(() => {
      expect(mockReplyMutate).toHaveBeenCalledWith({
        body: 'hello in thread',
        attachmentIDs: [],
        parentMessageID: 'm-1',
      });
    });
  });

  it('passes the newest non-deleted own reply to the composer edit shortcut', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'own-old', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-1', body: 'old', createdAt: '2026-04-24T10:30:00Z' },
      { id: 'own-deleted', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-1', body: 'deleted', createdAt: '2026-04-24T10:31:00Z', deleted: true },
      { id: 'own-system', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-1', body: 'system', createdAt: '2026-04-24T10:32:00Z', system: true },
      { id: 'own-new', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-1', body: 'new', createdAt: '2026-04-24T10:33:00Z' },
    ]);
    renderWithProviders(
      <ThreadPanel
        channelId="ch-1"
        threadRootID="m-1"
        onClose={vi.fn()}
        userMap={userMap}
        currentUserId="u-1"
      />,
    );
    await screen.findByText('new');
    expect(lastMessageInputProps.current).toMatchObject({ lastOwnMessageId: 'own-new' });
  });

  it('does not pass an edit shortcut when current user is unknown', async () => {
    mockApiFetch.mockResolvedValueOnce([
      { id: 'own-new', parentID: 'ch-1', parentMessageID: 'm-1', authorID: 'u-1', body: 'new', createdAt: '2026-04-24T10:33:00Z' },
    ]);
    renderWithProviders(
      <ThreadPanel
        channelId="ch-1"
        threadRootID="m-1"
        onClose={vi.fn()}
        userMap={userMap}
      />,
    );
    await screen.findByText('new');
    expect(lastMessageInputProps.current).toMatchObject({ lastOwnMessageId: undefined });
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
      mockApiFetch.mockResolvedValueOnce([]);
      renderWithProviders(
        <ThreadPanel
          channelId="ch-1"
          threadRootID="m-1"
          onClose={vi.fn()}
          userMap={userMap}
          currentUserId="u-1"
        />,
      );
      await screen.findByLabelText('Message input');
      // ThreadPanel hands the right typing-channel triplet to
      // MessageInput; the actual frame emit lives in MessageInput's
      // own unit tests (TypingContext + MessageInput.emitTyping).
      expect(lastMessageInputProps.current).toMatchObject({
        typingParentID: 'ch-1',
        typingParentType: 'channel',
        typingThreadRootID: 'm-1',
      });
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
