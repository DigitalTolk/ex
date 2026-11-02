import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const threadHasUnseenMock = vi.hoisted(() => vi.fn());
// How far the user had read when the thread opened, once the server says
// (useThreadSeenAtOpen).
const seenAtOpen = vi.hoisted(() => ({ current: { known: true, seenAt: undefined as string | undefined } }));
vi.mock('@/hooks/useThreads', () => ({
  useThreadMessages: () => ({ data: threadDataState.current, isLoading: false }),
  useThreadFollowing: () => ({ data: false }),
  useThreadSeenAtOpen: () => seenAtOpen.current,
  useFollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  useUnfollowThread: () => ({ mutate: vi.fn(), isPending: false }),
  markThreadSeen: markThreadSeenMock,
  noteThreadReadPosition: noteThreadReadPositionMock,
  threadHasUnseen: threadHasUnseenMock,
}));

import { ThreadPanel } from '@/components/chat/ThreadPanel';
import { endReadSession, holdRead, isAtBottom, isUnreadSeen, keepReadSession, setUnreadAnchor, threadReadKey } from '@/lib/read-position';
import { forceAwayUntilInput, markUserActivity, resetUserActivityForTests } from '@/lib/user-activity';

// The thread's "New messages" line and "Mark as unread" hold.
function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <TooltipProvider>
          <ThreadPanel channelId="ch-1" threadRootID="root-1" onClose={vi.fn()} userMap={{}} currentUserId="me" />
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return Object.assign(view, { refresh: () => view.rerender(tree()) });
}

const key = threadReadKey('root-1');
const at = (s: number) => `2026-10-07T09:00:0${s}Z`;

describe('ThreadPanel unread', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue([]);
    markThreadSeenMock.mockReset();
    noteThreadReadPositionMock.mockReset();
    threadHasUnseenMock.mockReset();
    threadHasUnseenMock.mockReturnValue(true);
    seenAtOpen.current = { known: true, seenAt: at(2) };
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
    noteThreadReadPositionMock.mockImplementation((root: string, seenAt: string) => setUnreadAnchor(threadReadKey(root), { kind: 'after', at: seenAt }));
    renderPanel();
    expect(noteThreadReadPositionMock).toHaveBeenCalledWith('root-1', at(2));
    expect(markThreadSeenMock).toHaveBeenCalledWith('root-1', at(3), { parentID: 'ch-1', parentType: 'channel' });
    expect(noteThreadReadPositionMock.mock.invocationCallOrder[0]).toBeLessThan(markThreadSeenMock.mock.invocationCallOrder[0]);
    const line = screen.getByTestId('unread-divider');
    expect(line.nextElementSibling?.textContent).toContain('second reply');
  });

  // Marking the thread seen before the server said how far the user had read
  // would hand the server's answer the new seen time: no line.
  it("neither notes the line nor marks the thread seen until the server says how far you had read", () => {
    seenAtOpen.current = { known: false, seenAt: undefined };
    const view = renderPanel();
    expect(noteThreadReadPositionMock).not.toHaveBeenCalled();
    expect(markThreadSeenMock).not.toHaveBeenCalled();
    // Coming back reads nothing yet either.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(markThreadSeenMock).not.toHaveBeenCalled();
    vi.restoreAllMocks();

    seenAtOpen.current = { known: true, seenAt: at(2) };
    view.refresh();
    expect(noteThreadReadPositionMock).toHaveBeenCalledWith('root-1', at(2));
    expect(markThreadSeenMock).toHaveBeenCalledWith('root-1', at(3), { parentID: 'ch-1', parentType: 'channel' });
    expect(noteThreadReadPositionMock.mock.invocationCallOrder[0]).toBeLessThan(markThreadSeenMock.mock.invocationCallOrder[0]);
  });

  // Noted once per opening: a later answer (a read elsewhere) doesn't move
  // the line.
  it('notes the line once per opening', () => {
    const view = renderPanel();
    seenAtOpen.current = { known: true, seenAt: at(3) };
    view.refresh();
    expect(noteThreadReadPositionMock).toHaveBeenCalledTimes(1);
    expect(noteThreadReadPositionMock).toHaveBeenCalledWith('root-1', at(2));
  });

  it('once the line has been seen it retires in place: same box, invisible, and the thread remembers', () => {
    type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
    const callbacks: IOCallback[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: IOCallback) { callbacks.push(cb); }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    });
    vi.useFakeTimers();
    // The reader is at this window (jsdom's never has focus).
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      setUnreadAnchor(key, { kind: 'after', at: at(2) });
      renderPanel();
      const line = screen.getByTestId('unread-divider');
      expect(line).not.toHaveAttribute('data-retired');
      act(() => callbacks[0]([{ isIntersecting: true }]));
      // Seen; it stays while the reader is here and retires once they
      // switch to another window.
      act(() => vi.advanceTimersByTime(3500));
      expect(isUnreadSeen(key)).toBe(false);
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      act(() => vi.advanceTimersByTime(500));
      expect(isUnreadSeen(key)).toBe(true);
      expect(screen.getByTestId('unread-divider')).toHaveAttribute('data-retired', 'true');
      expect(screen.getByTestId('unread-divider').nextElementSibling?.textContent).toContain('second reply');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
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

  describe('a reply while the user is away', () => {
    const reply = { id: 'r-3', authorID: 'u-2', body: 'third reply', createdAt: at(4), parentMessageID: 'root-1' };
    const target = { parentID: 'ch-1', parentType: 'channel' };
    const comeBack = () =>
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
    afterEach(() => {
      resetUserActivityForTests();
      vi.restoreAllMocks();
    });

    it('stays unread while the window is in the background, and is read when the user comes back', () => {
      const view = renderPanel();
      expect(markThreadSeenMock).toHaveBeenCalledWith('root-1', at(3), target);
      markThreadSeenMock.mockReset();
      forceAwayUntilInput();
      threadDataState.current = [...threadDataState.current, reply];
      view.refresh();
      expect(markThreadSeenMock).not.toHaveBeenCalled();
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      comeBack();
      expect(markThreadSeenMock).toHaveBeenCalledWith('root-1', at(4), target);
    });

    it('is still read at once while the user is looking', () => {
      const view = renderPanel();
      markThreadSeenMock.mockReset();
      threadDataState.current = [...threadDataState.current, reply];
      view.refresh();
      expect(markThreadSeenMock).toHaveBeenCalledWith('root-1', at(4), target);
    });

    // As in a channel: what arrives below the fold stays unread until the
    // user scrolls back down to it.
    it('stays unread while scrolled up — coming back included — and is read once scrolled back down', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const view = renderPanel();
      const list = screen.getByLabelText('Thread').querySelector('.overflow-y-auto') as HTMLElement;
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 400 });
      const scrollTo = (top: number) =>
        act(() => {
          list.scrollTop = top;
          list.dispatchEvent(new Event('scroll'));
        });
      scrollTo(600);
      scrollTo(100);
      expect(isAtBottom(key)).toBe(false);
      markThreadSeenMock.mockReset();

      threadDataState.current = [...threadDataState.current, reply];
      view.refresh();
      comeBack();
      expect(markThreadSeenMock).not.toHaveBeenCalled();

      scrollTo(600);
      expect(isAtBottom(key)).toBe(true);
      expect(markThreadSeenMock).toHaveBeenCalledTimes(1);
      expect(markThreadSeenMock).toHaveBeenCalledWith('root-1', at(4), target);
    });

    it('coming back sends nothing when nothing new arrived', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderPanel();
      markThreadSeenMock.mockReset();
      threadHasUnseenMock.mockReturnValue(false);
      comeBack();
      expect(markThreadSeenMock).not.toHaveBeenCalled();
      expect(threadHasUnseenMock).toHaveBeenCalledWith(expect.anything(), 'root-1', at(3));
    });

    // The window never lost focus: the user was idle in front of it.
    it('is read at the first input after an idle spell', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      const view = renderPanel();
      markThreadSeenMock.mockReset();
      forceAwayUntilInput();
      threadDataState.current = [...threadDataState.current, reply];
      view.refresh();
      expect(markThreadSeenMock).not.toHaveBeenCalled();
      act(() => markUserActivity());
      expect(markThreadSeenMock).toHaveBeenCalledWith('root-1', at(4), target);
    });

    it('coming back reads nothing while the thread is held unread or has nothing loaded', () => {
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      holdRead(key);
      const held = renderPanel();
      comeBack();
      expect(markThreadSeenMock).not.toHaveBeenCalled();
      held.unmount();
      endReadSession(key);
      threadDataState.current = [];
      renderPanel();
      comeBack();
      expect(markThreadSeenMock).not.toHaveBeenCalled();
    });
  });
});
