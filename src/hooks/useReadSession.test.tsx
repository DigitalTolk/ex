import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { useReadSession } from './useReadSession';
import { queryKeys } from '@/lib/query-keys';
import { endReadSession, getUnreadAnchor, holdRead, isAtBottom, isReadHeld, noteMissedArrival, setAtBottom, setUnreadAnchor, useMissedArrivals } from '@/lib/read-position';
import type { UserChannel, UserConversation } from '@/types';

function makeQC(unreadCount?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (unreadCount !== undefined) {
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), [
      { channelID: 'ch-1', channelName: 'general', channelType: 'public', role: 1, unreadCount },
    ]);
  }
  return qc;
}

function render(qc: QueryClient, parentID: string | undefined, markRead = vi.fn(), parentType: 'channel' | 'conversation' = 'channel', strict = false) {
  const wrapper = ({ children }: { children: ReactNode }) => {
    const tree = <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
  const hook = renderHook(({ id }: { id?: string }) => useReadSession(parentType, id, markRead), {
    wrapper,
    initialProps: { id: parentID },
  });
  return { ...hook, markRead };
}

afterEach(() => {
  for (const key of ['ch-1', 'ch-2', 'dm-1']) endReadSession(key);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useReadSession', () => {
  it('opening reads the chat, but first records where its unread messages start', () => {
    const { markRead } = render(makeQC(4), 'ch-1');
    expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'count', count: 4 });
    expect(markRead).toHaveBeenCalledWith('ch-1');
  });

  it('opens once, even under StrictMode, and nothing unread draws no line', () => {
    const { markRead } = render(makeQC(0), 'ch-1', vi.fn(), 'channel', true);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(getUnreadAnchor('ch-1')).toBeUndefined();
  });

  it('a chat held unread is not read on open', () => {
    holdRead('ch-1');
    const { markRead } = render(makeQC(2), 'ch-1');
    expect(markRead).not.toHaveBeenCalled();
  });

  it('waits for a loading list before opening; no list at all opens at once', async () => {
    const qc = new QueryClient();
    let finish: (rows: UserConversation[]) => void = () => {};
    void qc.prefetchQuery({ queryKey: queryKeys.userConversations(), queryFn: () => new Promise((r) => (finish = r)) });
    const { markRead } = render(qc, 'dm-1', vi.fn(), 'conversation');
    expect(markRead).not.toHaveBeenCalled();
    await act(async () => {
      finish([{ conversationID: 'dm-1', type: 'dm', displayName: 'Me', unreadCount: 1 } as UserConversation]);
    });
    // The cache notification is batched onto a later tick.
    await waitFor(() => expect(markRead).toHaveBeenCalledWith('dm-1'));
    expect(getUnreadAnchor('dm-1')).toEqual({ kind: 'count', count: 1 });

    const bare = render(new QueryClient(), 'ch-2');
    expect(bare.markRead).toHaveBeenCalledWith('ch-2');
  });

  it('leaving ends the visit: the line and any hold go', () => {
    vi.useFakeTimers();
    const { unmount, rerender } = render(makeQC(3), 'ch-1');
    holdRead('ch-1');
    rerender({ id: 'ch-2' });
    act(() => vi.runAllTimers());
    expect(getUnreadAnchor('ch-1')).toBeUndefined();
    expect(isReadHeld('ch-1')).toBe(false);
    setUnreadAnchor('ch-2', { kind: 'count', count: 1 });
    unmount();
    act(() => vi.runAllTimers());
    expect(getUnreadAnchor('ch-2')).toBeUndefined();
  });

  it('coming back to the window reads it — unless scrolled up or held', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { markRead } = render(makeQC(0), 'ch-1');
    markRead.mockClear();
    const focus = () => act(() => window.dispatchEvent(new Event('focus')));
    focus();
    expect(markRead).toHaveBeenCalledTimes(1);
    setAtBottom('ch-1', false);
    focus();
    setAtBottom('ch-1', true);
    holdRead('ch-1');
    focus();
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('reaching the bottom reads what arrived meanwhile, unless held or nothing is unread', () => {
    const qc = makeQC(0);
    const { result, markRead } = render(qc, 'ch-1');
    markRead.mockClear();
    act(() => result.current.onAtBottomChange(false));
    expect(isAtBottom('ch-1')).toBe(false);
    act(() => result.current.onAtBottomChange(true));
    expect(markRead).not.toHaveBeenCalled(); // nothing unread
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), (rows) => rows!.map((c) => ({ ...c, unreadCount: 2 })));
    act(() => result.current.onAtBottomChange(true));
    expect(markRead).toHaveBeenCalledTimes(1);
    holdRead('ch-1');
    act(() => result.current.onAtBottomChange(true));
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('reaching the bottom before the chat\'s row is loaded reads nothing', () => {
    const { result, markRead } = render(new QueryClient(), 'ch-1');
    markRead.mockClear();
    act(() => result.current.onAtBottomChange(true));
    expect(markRead).not.toHaveBeenCalled();
  });

  it('"Mark as read" clears the line and the hold, then reads', () => {
    const { result, markRead } = render(makeQC(2), 'ch-1');
    holdRead('ch-1');
    markRead.mockClear();
    act(() => result.current.markAllRead());
    expect(getUnreadAnchor('ch-1')).toBeUndefined();
    expect(isReadHeld('ch-1')).toBe(false);
    expect(markRead).toHaveBeenCalledWith('ch-1');
  });

  it('does nothing without a chat', () => {
    const { result, markRead } = render(makeQC(2), undefined);
    act(() => {
      result.current.onAtBottomChange(true);
      result.current.markAllRead();
    });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('jumping to the latest forgets missed arrivals and puts the line where the unread start', () => {
    const qc = makeQC(0);
    const { result } = render(qc, 'ch-1');
    const missed = renderHook(() => useMissedArrivals('ch-1'));
    act(() => noteMissedArrival('ch-1'));
    expect(missed.result.current).toBe(1);
    act(() => result.current.prepareJumpToLatest());
    expect(missed.result.current).toBe(0);
    expect(getUnreadAnchor('ch-1')).toBeUndefined(); // nothing unread: no line
    qc.setQueryData<UserChannel[]>(queryKeys.userChannels(), (rows) => rows!.map((c) => ({ ...c, unreadCount: 3 })));
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'older' });
    act(() => result.current.prepareJumpToLatest());
    expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'count', count: 3 });
  });

  it('jumping to the latest without a chat, or before its row loads, draws nothing', () => {
    const none = render(makeQC(2), undefined);
    act(() => none.result.current.prepareJumpToLatest());
    const bare = render(new QueryClient(), 'ch-2');
    act(() => bare.result.current.prepareJumpToLatest());
    expect(getUnreadAnchor('ch-2')).toBeUndefined();
  });
});
