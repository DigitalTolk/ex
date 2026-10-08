import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { mergeSeenMaps, unreadThreadIDs, unreadThreadParents, upsertUserThreadRow, type ThreadSummary } from './useThreads';
import { queryKeys } from '@/lib/query-keys';

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

describe('upsertUserThreadRow (jsdom)', () => {
  it('inserts a new row and updates an existing one, sorting newest activity first', () => {
    const qc = new QueryClient();
    upsertUserThreadRow(qc, summary({ threadRootID: 't-1', latestActivityAt: '2026-01-01T00:00:00Z' }));
    upsertUserThreadRow(qc, summary({ threadRootID: 't-2', latestActivityAt: '2026-01-03T00:00:00Z' }));
    upsertUserThreadRow(qc, summary({ threadRootID: 't-1', replyCount: 9, latestActivityAt: '2026-01-04T00:00:00Z' }));
    const list = qc.getQueryData<ThreadSummary[]>(queryKeys.userThreads());
    expect(list?.map((t) => [t.threadRootID, t.replyCount])).toEqual([['t-1', 9], ['t-2', 1]]);
  });

  it('is a no-op when threadRootID is empty', () => {
    const qc = new QueryClient();
    upsertUserThreadRow(qc, summary({ threadRootID: '' }));
    expect(qc.getQueryData(queryKeys.userThreads())).toBeUndefined();
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

  it('clears the unread badge end-to-end once the server watermark covers the reply', () => {
    // Full GAP-2 shape through unreadThreadIDs: server notification row still
    // listed, reply at T2, mobile read at T3 — the merged seen map must
    // reconcile the thread OUT of the unread set.
    const threads = [summary({ threadRootID: 't-1', latestActivityAt: '2026-07-14T12:00:02Z' })];
    const merged = mergeSeenMaps(
      { 't-1': '2026-07-14T12:00:03Z' },
      { 't-1': '2026-07-14T12:00:01Z' },
    );
    expect(unreadThreadIDs(threads, ['t-1'], new Set(), merged).has('t-1')).toBe(false);
    // Sanity: with the OLD spread semantics the stale local entry keeps it unread.
    const stale = { 't-1': '2026-07-14T12:00:01Z' };
    expect(unreadThreadIDs(threads, ['t-1'], new Set(), stale).has('t-1')).toBe(true);
  });
});

describe('unreadThreadParents', () => {
  it('names each chat holding an unread thread, once', () => {
    const threads = [
      summary({ threadRootID: 't-1', parentID: 'ch-1' }),
      summary({ threadRootID: 't-2', parentID: 'ch-1' }),
      summary({ threadRootID: 't-3', parentID: 'dm-1' }),
    ];
    expect([...unreadThreadParents(threads, new Set(['t-1', 't-2']))]).toEqual(['ch-1']);
    expect(unreadThreadParents(undefined, new Set(['t-1'])).size).toBe(0);
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

  it('a real view (one that persists) drops the cached mark, which the server drops too', async () => {
    const { markThreadSeen } = await import('./useThreads');
    const { queryClient } = await import('@/lib/query-client');
    const apiModule = await import('@/lib/api');
    const spy = vi.spyOn(apiModule, 'apiFetch').mockResolvedValue(undefined);
    const base = { threadNotifications: [], threadSeen: {}, hiddenConversations: [], hiddenSkills: [] };
    queryClient.setQueryData(queryKeys.userState(), { ...base, threadMarkedUnread: { 't-1': 'x', 't-2': 'y' } });
    markThreadSeen('t-1', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    expect(queryClient.getQueryData<{ threadMarkedUnread: Record<string, string> }>(queryKeys.userState())?.threadMarkedUnread).toEqual({ 't-2': 'y' });
    // No mark for this thread: the cached state is left as is.
    const before = queryClient.getQueryData(queryKeys.userState());
    markThreadSeen('t-3', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    expect(queryClient.getQueryData(queryKeys.userState())).toBe(before);
    queryClient.removeQueries({ queryKey: queryKeys.userState() });
    markThreadSeen('t-4', '2026-01-09T00:00:00Z', { parentID: 'ch-1', parentType: 'channel' });
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});
