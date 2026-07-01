import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { upsertUserThreadRow, type ThreadSummary } from './useThreads';
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
