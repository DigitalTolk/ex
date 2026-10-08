import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useFrequentEmojis: () => ['thumbsup', 'heart', 'tada'],
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

const sendMutate = vi.fn();
vi.mock('@/hooks/useMarkUnread', () => ({ useMarkUnread: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSendMessage: () => ({ mutate: sendMutate, isPending: false }),
}));

const threadDataState: { current: { id: string; authorID: string; body: string; createdAt: string; parentID?: string; parentMessageID?: string }[] } = {
  current: [],
};
const markThreadSeenMock = vi.hoisted(() => vi.fn());
const noteThreadReadPositionMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/useThreads', () => ({
  useThreadMessages: () => ({ data: threadDataState.current, isLoading: false }),
  useUserThreads: () => ({ data: [] }),
  useFollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  useUnfollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  markThreadSeen: markThreadSeenMock,
  noteThreadReadPosition: noteThreadReadPositionMock,
}));

import { ThreadPanel } from '@/components/chat/ThreadPanel';
import { endReadSession, holdRead, keepReadSession, setUnreadAnchor, threadReadKey } from '@/lib/read-position';

// The thread's "New messages" line and "Mark as unread" hold.
function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <TooltipProvider>
          <ThreadPanel channelId="ch-1" threadRootID="root-1" onClose={vi.fn()} userMap={{}} currentUserId="me" />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const key = threadReadKey('root-1');
const at = (s: number) => `2026-10-07T09:00:0${s}Z`;

describe('ThreadPanel unread', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([]);
    markThreadSeenMock.mockReset();
    noteThreadReadPositionMock.mockReset();
    // The previous test's unmount scheduled an end for this thread's visit.
    keepReadSession(key);
    endReadSession(key);
    threadDataState.current = [
      { id: 'root-1', authorID: 'u-1', body: 'the root', createdAt: at(1) },
      { id: 'r-1', authorID: 'u-2', body: 'first reply', createdAt: at(2), parentMessageID: 'root-1' },
      { id: 'r-2', authorID: 'u-2', body: 'second reply', createdAt: at(3), parentMessageID: 'root-1' },
    ];
  });

  it('notes where you had read before marking the thread seen, and draws the line at the first newer reply', () => {
    noteThreadReadPositionMock.mockImplementation(() => setUnreadAnchor(key, { kind: 'after', at: at(2) }));
    renderPanel();
    expect(noteThreadReadPositionMock).toHaveBeenCalledWith(expect.anything(), 'root-1');
    expect(markThreadSeenMock).toHaveBeenCalledWith('root-1', at(3), { parentID: 'ch-1', parentType: 'channel' });
    const line = screen.getByTestId('unread-divider');
    expect(line.nextElementSibling?.textContent).toContain('second reply');
  });

  it('never puts the line on the root', () => {
    setUnreadAnchor(key, { kind: 'after', at: at(0) });
    renderPanel();
    expect(screen.getByTestId('unread-divider').nextElementSibling?.textContent).toContain('first reply');
  });

  it('draws no line when no reply is newer than where you had read', () => {
    setUnreadAnchor(key, { kind: 'after', at: at(9) });
    renderPanel();
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });

  it('a thread held unread is not marked seen while open', () => {
    holdRead(key);
    setUnreadAnchor(key, { kind: 'message', messageID: 'r-1' });
    renderPanel();
    expect(markThreadSeenMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('unread-divider').nextElementSibling?.textContent).toContain('first reply');
  });

  it('closing the panel ends the visit', () => {
    vi.useFakeTimers();
    holdRead(key);
    setUnreadAnchor(key, { kind: 'message', messageID: 'r-1' });
    const view = renderPanel();
    view.unmount();
    act(() => vi.runAllTimers());
    vi.useRealTimers();
    renderPanel();
    expect(screen.queryByTestId('unread-divider')).toBeNull();
    expect(markThreadSeenMock).toHaveBeenCalled();
  });
});
