import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { mergeSeenMaps, unreadThreadIDs, upsertUserThreadRow, type ThreadSummary } from './useThreads';
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
