import { describe, it, expect, vi } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { mergeSeenMaps, patchListedThread, patchListedThreadFromRoot, unreadThreadIDs, type ThreadPage, type ThreadSummary } from './useThreads';
import { queryKeys } from '@/lib/query-keys';
import type { Message } from '@/types';

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

describe('unreadThreadIDs', () => {
  it('is the server markers plus the alerts that arrived since', () => {
    expect([...unreadThreadIDs(['t-1'], new Set(['t-2', 't-1']))].sort()).toEqual(['t-1', 't-2']);
    expect(unreadThreadIDs().size).toBe(0);
  });
});

describe('mergeSeenMaps', () => {
  it('lets a newer SERVER watermark beat a stale local entry (GAP-2 regression)', () => {
    // Read on desktop at T1, reply at T2, read on MOBILE at T3. The old
    // {...server, ...local} spread kept the stale local T1, so the thread
    // stayed unread on desktop forever. The merge must keep the newer T3.
    const merged = mergeSeenMaps(
      { 't-1': '2026-07-14T12:00:03Z' }, // server: mobile read at T3
      { 't-1': '2026-07-14T12:00:01Z' }, // local: desktop read at T1
    );
    expect(merged['t-1']).toBe('2026-07-14T12:00:03Z');
  });

  it('keeps a newer LOCAL entry (optimistic read not yet persisted)', () => {
    const merged = mergeSeenMaps(
      { 't-1': '2026-07-14T12:00:01Z' },
      { 't-1': '2026-07-14T12:00:05Z' },
    );
    expect(merged['t-1']).toBe('2026-07-14T12:00:05Z');
  });

  it('unions keys present on only one side and tolerates an absent server map', () => {
    expect(mergeSeenMaps({ a: '2026-01-01T00:00:00Z' }, { b: '2026-01-02T00:00:00Z' })).toEqual({
      a: '2026-01-01T00:00:00Z',
      b: '2026-01-02T00:00:00Z',
    });
    expect(mergeSeenMaps(undefined, { b: '2026-01-02T00:00:00Z' })).toEqual({ b: '2026-01-02T00:00:00Z' });
  });

  it('never lets a corrupt timestamp outrank a real one', () => {
    expect(mergeSeenMaps({ a: '2026-01-01T00:00:00Z' }, { a: 'not-a-date' })['a']).toBe('2026-01-01T00:00:00Z');
    expect(mergeSeenMaps({ a: 'not-a-date' }, { a: '2026-01-01T00:00:00Z' })['a']).toBe('2026-01-01T00:00:00Z');
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

describe('mark as unread: seen-map rules', () => {
  it('a mark beats a local seen time from before it; seeing the thread after the mark wins again', () => {
    const server = { t: '2026-01-01T00:00:00Z' }; // rewound by the mark
    const marked = { t: '2026-01-05T00:00:00Z' };
    expect(mergeSeenMaps(server, { t: '2026-01-04T00:00:00Z' }, marked)).toEqual(server);
    expect(mergeSeenMaps(server, { t: '2026-01-06T00:00:00Z' }, marked)).toEqual({ t: '2026-01-06T00:00:00Z' });
  });

  it('threadSeenAt merges the server and this device the same way', async () => {
    const { threadSeenAt, markThreadSeen, resetSeenCache } = await import('./useThreads');
    localStorage.clear();
    resetSeenCache();
    markThreadSeen('t-9', '2026-01-03T00:00:00Z');
    const state = { threadNotifications: [], threadSeen: { 't-9': '2026-01-01T00:00:00Z' }, hiddenConversations: [], hiddenSkills: [] };
    expect(threadSeenAt(state, 't-9')).toBe('2026-01-03T00:00:00Z');
    expect(threadSeenAt({ ...state, threadMarkedUnread: { 't-9': '2026-01-04T00:00:00Z' } }, 't-9')).toBe('2026-01-01T00:00:00Z');
    expect(threadSeenAt(undefined, 'nope')).toBeUndefined();
  });

  it('noteThreadReadPosition anchors the line at the seen time, and only when there is one', async () => {
    const { noteThreadReadPosition, resetSeenCache } = await import('./useThreads');
    const { endReadSession, getUnreadAnchor, threadReadKey } = await import('@/lib/read-position');
    localStorage.clear();
    resetSeenCache();
    const qc = new QueryClient();
    noteThreadReadPosition(qc, 't-new');
    expect(getUnreadAnchor(threadReadKey('t-new'))).toBeUndefined();
    qc.setQueryData(queryKeys.userState(), { threadNotifications: [], threadSeen: { 't-old': '2026-01-01T00:00:00Z' }, hiddenConversations: [], hiddenSkills: [] });
    noteThreadReadPosition(qc, 't-old');
    expect(getUnreadAnchor(threadReadKey('t-old'))).toEqual({ kind: 'after', at: '2026-01-01T00:00:00Z' });
    endReadSession(threadReadKey('t-old'));
  });

  // A reply arriving unseen in the open thread moves the line to it: the
  // first reply after how far the user has seen, not where the line was when
  // the thread opened.
  it('noteThreadReadPosition can move a line already drawn', async () => {
    const { noteThreadReadPosition, resetSeenCache } = await import('./useThreads');
    const { endReadSession, getUnreadAnchor, setUnreadAnchor, threadReadKey } = await import('@/lib/read-position');
    localStorage.clear();
    resetSeenCache();
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.userState(), { threadNotifications: [], threadSeen: { 't-1': '2026-01-02T00:00:00Z' }, hiddenConversations: [], hiddenSkills: [] });
    setUnreadAnchor(threadReadKey('t-1'), { kind: 'after', at: '2026-01-01T00:00:00Z' });
    noteThreadReadPosition(qc, 't-1');
    expect(getUnreadAnchor(threadReadKey('t-1'))).toEqual({ kind: 'after', at: '2026-01-01T00:00:00Z' });
    noteThreadReadPosition(qc, 't-1', { replace: true });
    expect(getUnreadAnchor(threadReadKey('t-1'))).toEqual({ kind: 'after', at: '2026-01-02T00:00:00Z' });
    endReadSession(threadReadKey('t-1'));
  });

  it('threadHasUnseen compares a reply with how far the thread is seen, here or on another device', async () => {
    const { markThreadSeen, resetSeenCache, threadHasUnseen } = await import('./useThreads');
    localStorage.clear();
    resetSeenCache();
    const qc = new QueryClient();
    expect(threadHasUnseen(qc, 't-1', '2026-01-02T00:00:00Z')).toBe(true);
    qc.setQueryData(queryKeys.userState(), { threadNotifications: [], threadSeen: { 't-1': '2026-01-02T00:00:00Z' }, hiddenConversations: [], hiddenSkills: [] });
    expect(threadHasUnseen(qc, 't-1', '2026-01-02T00:00:00Z')).toBe(false);
    expect(threadHasUnseen(qc, 't-1', '2026-01-03T00:00:00Z')).toBe(true);
    markThreadSeen('t-1', '2026-01-03T00:00:00Z');
    expect(threadHasUnseen(qc, 't-1', '2026-01-03T00:00:00Z')).toBe(false);
  });

  it('seeing a thread drops its cached unread marker and mark, which the server drops too', async () => {
    const { markThreadSeen } = await import('./useThreads');
    const { queryClient } = await import('@/lib/query-client');
    const apiModule = await import('@/lib/api');
    const spy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue(undefined);
    const base = { threadSeen: {}, hiddenConversations: [], hiddenSkills: [] };
    queryClient.setQueryData(queryKeys.userState(), { ...base, threadNotifications: ['t-1', 't-5'], threadMarkedUnread: { 't-1': 'x', 't-2': 'y' } });
    markThreadSeen('t-1', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    let state = queryClient.getQueryData<{ threadMarkedUnread: Record<string, string>; threadNotifications: string[] }>(queryKeys.userState());
    expect(state?.threadMarkedUnread).toEqual({ 't-2': 'y' });
    expect(state?.threadNotifications).toEqual(['t-5']);
    // Without a PUT (the user's own reply, which the server reads for them)
    // the marker goes all the same.
    markThreadSeen('t-5', '2026-01-09T00:00:00Z');
    state = queryClient.getQueryData(queryKeys.userState());
    expect(state?.threadNotifications).toEqual([]);
    // Nothing marked for this thread: the cached state is left as is.
    const before = queryClient.getQueryData(queryKeys.userState());
    markThreadSeen('t-3', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    expect(queryClient.getQueryData(queryKeys.userState())).toBe(before);
    queryClient.removeQueries({ queryKey: queryKeys.userState() });
    markThreadSeen('t-4', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
