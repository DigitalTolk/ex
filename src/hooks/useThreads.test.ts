import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { patchListedThread, patchListedThreadFromRoot, threadSeenAt, type ThreadPage, type ThreadSummary } from './useThreads';
import { queryKeys } from '@/lib/query-keys';
import type { Message, ThreadReadState } from '@/types';

const summary = (overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  parentID: 'ch-1',
  parentType: 'channel',
  threadRootID: 't-1',
  rootAuthorID: 'u-1',
  rootBody: 'hi',
  rootCreatedAt: '2026-01-01T00:00:00Z',
  replyCount: 1,
  latestActivityAt: '2026-01-02T00:00:00Z',
  ...overrides,
});

function pagesData(...pages: ThreadSummary[][]): InfiniteData<ThreadPage> {
  return { pages: pages.map((threads) => ({ threads })), pageParams: pages.map((_, i) => (i ? `c${i}` : '')) };
}

function listed(qc: QueryClient, visit = 'v1'): Array<[string, number, boolean | undefined]> {
  const data = qc.getQueryData<InfiniteData<ThreadPage>>(queryKeys.threadPages(visit));
  return (data?.pages ?? []).flatMap((p) => p.threads.map((t) => [t.threadRootID, t.replyCount, t.following] as [string, number, boolean | undefined]));
}

describe('listed threads are patched in place', () => {
  it('a thread.updated rewrites the listed row, keeps its unread flag, and adds or moves nothing', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.threadPages('v1'), pagesData([summary({ threadRootID: 't-1', unread: true })], [summary({ threadRootID: 't-2' })]));
    patchListedThread(qc, summary({ threadRootID: 't-2', replyCount: 9, latestActivityAt: '2026-01-09T00:00:00Z' }));
    patchListedThread(qc, summary({ threadRootID: 't-new' }));
    expect(listed(qc)).toEqual([['t-1', 1, undefined], ['t-2', 9, undefined]]);
    patchListedThread(qc, summary({ threadRootID: 't-1', replyCount: 4 }));
    const first = qc.getQueryData<InfiniteData<ThreadPage>>(queryKeys.threadPages('v1'))?.pages[0].threads[0];
    expect(first?.unread).toBe(true);
    expect(first?.replyCount).toBe(4);
  });

  it('a root edit updates the listed row from the root, and leaves replies and unlisted roots alone', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.threadPages('v1'), pagesData([summary({ threadRootID: 't-1' })]));
    const root = { id: 't-1', parentID: 'ch-1', authorID: 'u-2', body: 'edited', createdAt: '2026-01-01T00:00:00Z', replyCount: 3, lastReplyAt: '2026-01-05T00:00:00Z' } as Message;
    patchListedThreadFromRoot(qc, root);
    patchListedThreadFromRoot(qc, { ...root, id: 'r-1', parentMessageID: 't-1', body: 'a reply' });
    let row = qc.getQueryData<InfiniteData<ThreadPage>>(queryKeys.threadPages('v1'))?.pages[0].threads[0];
    expect(row).toMatchObject({ rootBody: 'edited', rootAuthorID: 'u-2', replyCount: 3, latestActivityAt: '2026-01-05T00:00:00Z' });
    // A root without the reply fields keeps what the row had.
    patchListedThreadFromRoot(qc, { ...root, replyCount: undefined, lastReplyAt: undefined, body: 'again' });
    row = qc.getQueryData<InfiniteData<ThreadPage>>(queryKeys.threadPages('v1'))?.pages[0].threads[0];
    expect(row).toMatchObject({ rootBody: 'again', replyCount: 3, latestActivityAt: '2026-01-05T00:00:00Z' });
    // No list loaded: nothing to patch, nothing made up.
    const empty = new QueryClient();
    patchListedThreadFromRoot(empty, root);
    expect(empty.getQueryData(queryKeys.threadPages('v1'))).toBeUndefined();
  });
});

describe('threadSeenAt', () => {
  it('lets a newer SERVER seen time beat a stale local one (GAP-2 regression)', () => {
    // Read on desktop at T1, reply at T2, read on MOBILE at T3. Preferring
    // the stale local T1 kept the thread unread on desktop forever. The merge
    // must keep the newer T3.
    expect(threadSeenAt({ seenAt: '2026-07-14T12:00:03Z' }, '2026-07-14T12:00:01Z')).toBe('2026-07-14T12:00:03Z');
  });

  it('keeps a newer LOCAL seen time (optimistic read not yet persisted)', () => {
    expect(threadSeenAt({ seenAt: '2026-07-14T12:00:01Z' }, '2026-07-14T12:00:05Z')).toBe('2026-07-14T12:00:05Z');
  });

  it('takes whichever side has a seen time, and nothing when neither does', () => {
    expect(threadSeenAt({ seenAt: '2026-01-01T00:00:00Z' }, undefined)).toBe('2026-01-01T00:00:00Z');
    expect(threadSeenAt(undefined, '2026-01-02T00:00:00Z')).toBe('2026-01-02T00:00:00Z');
    expect(threadSeenAt(undefined, undefined)).toBeUndefined();
  });

  it('never lets a corrupt timestamp outrank a real one', () => {
    expect(threadSeenAt({ seenAt: '2026-01-01T00:00:00Z' }, 'not-a-date')).toBe('2026-01-01T00:00:00Z');
    expect(threadSeenAt({ seenAt: 'not-a-date' }, '2026-01-01T00:00:00Z')).toBe('2026-01-01T00:00:00Z');
  });

  it('a mark beats a local seen time from before it; seeing the thread after the mark wins again', () => {
    const server: ThreadReadState = { seenAt: '2026-01-01T00:00:00Z', markedUnreadAt: '2026-01-05T00:00:00Z' };
    expect(threadSeenAt(server, '2026-01-04T00:00:00Z')).toBe('2026-01-01T00:00:00Z');
    expect(threadSeenAt(server, '2026-01-06T00:00:00Z')).toBe('2026-01-06T00:00:00Z');
  });
});

describe('useThreadSeenAtOpen', () => {
  function wrapper(qc: QueryClient) {
    return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
  }

  // How far the user had read when the thread opened: the server's answer
  // merged with this device's seen time from before the open marked it seen.
  it("asks the server for this one thread and merges its answer with this device's seen time at open", async () => {
    const { markThreadSeen, resetSeenCache, useThreadSeenAtOpen } = await import('./useThreads');
    const apiModule = await import('@/lib/api');
    localStorage.clear();
    resetSeenCache();
    markThreadSeen('root/1', '2026-01-01T00:00:00Z');
    let answer: (v: ThreadReadState) => void = () => {};
    const spy = vi.spyOn(apiModule, 'apiFetch').mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const qc = new QueryClient();
    const { result } = renderHook(() => useThreadSeenAtOpen('root/1'), { wrapper: wrapper(qc) });
    expect(result.current.known).toBe(false);
    expect(spy).toHaveBeenCalledWith('/api/v1/user-state/threads/root%2F1');
    // The open marks the thread seen on this device: the time at open stays.
    markThreadSeen('root/1', '2026-01-09T00:00:00Z');
    answer({ seenAt: '2026-01-03T00:00:00Z' });
    await waitFor(() => expect(result.current).toEqual({ known: true, seenAt: '2026-01-03T00:00:00Z' }));
    spy.mockRestore();
  });

  it('reads an empty answer as never opened, and a failed one leaves this device alone', async () => {
    const { markThreadSeen, resetSeenCache, useThreadSeenAtOpen } = await import('./useThreads');
    const apiModule = await import('@/lib/api');
    localStorage.clear();
    resetSeenCache();
    const spy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'));
    const qc = new QueryClient();
    const never = renderHook(() => useThreadSeenAtOpen('root-2'), { wrapper: wrapper(qc) });
    await waitFor(() => expect(never.result.current).toEqual({ known: true, seenAt: undefined }));
    markThreadSeen('root-3', '2026-01-02T00:00:00Z');
    const failed = renderHook(() => useThreadSeenAtOpen('root-3'), { wrapper: wrapper(qc) });
    await waitFor(() => expect(failed.result.current).toEqual({ known: true, seenAt: '2026-01-02T00:00:00Z' }));
    spy.mockRestore();
  });
});

describe('markThreadSeen user-state echo window', () => {
  it('arms the ignore window only when the seen PUT is issued (target present)', async () => {
    const { markThreadSeen } = await import('./useThreads');
    const { resetUserStateSessionState, shouldRefetchUserStateForRemoteUpdate } = await import('./useUserState');
    resetUserStateSessionState();
    try {
      markThreadSeen('root-local'); // local-only: no PUT, no echo to ignore
      expect(shouldRefetchUserStateForRemoteUpdate()).toBe(true);
      markThreadSeen('root-remote', new Date().toISOString(), { parentID: 'ch-1', parentType: 'channel' });
      expect(shouldRefetchUserStateForRemoteUpdate()).toBe(false);
    } finally {
      resetUserStateSessionState();
    }
  });
});

describe('read position', () => {
  it('noteThreadReadPosition anchors the line at the seen time, and only when there is one', async () => {
    const { noteThreadReadPosition } = await import('./useThreads');
    const { endReadSession, getUnreadAnchor, threadReadKey } = await import('@/lib/read-position');
    noteThreadReadPosition('t-new', undefined);
    expect(getUnreadAnchor(threadReadKey('t-new'))).toBeUndefined();
    noteThreadReadPosition('t-old', '2026-01-01T00:00:00Z');
    expect(getUnreadAnchor(threadReadKey('t-old'))).toEqual({ kind: 'after', at: '2026-01-01T00:00:00Z' });
    endReadSession(threadReadKey('t-old'));
  });

  // A reply arriving unseen in the open thread moves the line to it: the
  // first reply after how far the user has seen, not where the line was when
  // the thread opened.
  it('noteUnseenThreadReply moves a line already drawn to how far the thread is seen now', async () => {
    const { noteThreadReadPosition, noteUnseenThreadReply, resetSeenCache } = await import('./useThreads');
    const { endReadSession, getUnreadAnchor, threadReadKey } = await import('@/lib/read-position');
    localStorage.clear();
    resetSeenCache();
    const qc = new QueryClient();
    noteThreadReadPosition('t-1', '2026-01-01T00:00:00Z');
    noteThreadReadPosition('t-1', '2026-01-02T00:00:00Z');
    expect(getUnreadAnchor(threadReadKey('t-1'))).toEqual({ kind: 'after', at: '2026-01-01T00:00:00Z' });
    qc.setQueryData<ThreadReadState>(queryKeys.threadRead('t-1'), { seenAt: '2026-01-02T00:00:00Z' });
    noteUnseenThreadReply(qc, 't-1');
    expect(getUnreadAnchor(threadReadKey('t-1'))).toEqual({ kind: 'after', at: '2026-01-02T00:00:00Z' });
    endReadSession(threadReadKey('t-1'));
  });

  it('threadHasUnseen compares a reply with how far the thread is seen, here or on another device', async () => {
    const { markThreadSeen, resetSeenCache, threadHasUnseen } = await import('./useThreads');
    localStorage.clear();
    resetSeenCache();
    const qc = new QueryClient();
    expect(threadHasUnseen(qc, 't-1', '2026-01-02T00:00:00Z')).toBe(true);
    qc.setQueryData<ThreadReadState>(queryKeys.threadRead('t-1'), { seenAt: '2026-01-02T00:00:00Z' });
    expect(threadHasUnseen(qc, 't-1', '2026-01-02T00:00:00Z')).toBe(false);
    expect(threadHasUnseen(qc, 't-1', '2026-01-03T00:00:00Z')).toBe(true);
    markThreadSeen('t-1', '2026-01-03T00:00:00Z');
    expect(threadHasUnseen(qc, 't-1', '2026-01-03T00:00:00Z')).toBe(false);
  });

  it("seeing a thread drops its cached unread marker and mark, which the server drops too", async () => {
    const { markThreadSeen } = await import('./useThreads');
    const { queryClient } = await import('@/lib/query-client');
    const apiModule = await import('@/lib/api');
    const spy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue(undefined);
    const base = { hiddenConversations: [], hiddenSkills: [] };
    queryClient.setQueryData(queryKeys.userState(), { ...base, threadNotifications: ['t-1', 't-5'] });
    queryClient.setQueryData<ThreadReadState>(queryKeys.threadRead('t-1'), { seenAt: '2026-01-01T00:00:00Z', markedUnreadAt: '2026-01-02T00:00:00Z' });
    markThreadSeen('t-1', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    let state = queryClient.getQueryData<{ threadNotifications: string[] }>(queryKeys.userState());
    expect(state?.threadNotifications).toEqual(['t-5']);
    expect(queryClient.getQueryData(queryKeys.threadRead('t-1'))).toEqual({ seenAt: '2026-01-01T00:00:00Z' });
    // Without a PUT (the user's own reply, which the server reads for them)
    // the marker goes all the same.
    markThreadSeen('t-5', '2026-01-09T00:00:00Z');
    state = queryClient.getQueryData(queryKeys.userState());
    expect(state?.threadNotifications).toEqual([]);
    // Nothing marked for this thread: the cached state is left as is.
    const before = queryClient.getQueryData(queryKeys.userState());
    const readBefore = queryClient.getQueryData(queryKeys.threadRead('t-1'));
    markThreadSeen('t-1', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    expect(queryClient.getQueryData(queryKeys.userState())).toBe(before);
    expect(queryClient.getQueryData(queryKeys.threadRead('t-1'))).toBe(readBefore);
    // Nothing cached at all: nothing is made up.
    queryClient.removeQueries({ queryKey: queryKeys.userState() });
    markThreadSeen('t-4', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    expect(queryClient.getQueryData(queryKeys.userState())).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.threadRead('t-4'))).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(3);
    queryClient.removeQueries({ queryKey: queryKeys.threadReadAll() });
    spy.mockRestore();
  });
});
