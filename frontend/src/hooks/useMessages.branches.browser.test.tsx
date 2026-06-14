import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  updateMessageInCache,
  markMessageDeletedInCache,
  removeMessageFromCache,
  resyncMessageCache,
  type MessageWindow,
  type MessagePageParam,
} from './useMessages';
import { queryKeys } from '@/lib/query-keys';
import type { Message } from '@/types';

// Branch-level coverage for the surgical cache helpers' defensive /
// no-change arms that the main useMessages.browser.test does not reach:
// the `!old` guards (updater invoked on an empty query), the
// non-matching `: m` map arm, the `changed ? … : old` unchanged arm,
// catchUpTail's `!old` guard, and the third `?? head.newestID` fallback.

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

const msg = (overrides: Partial<Message> = {}): Message => ({
  id: 'm-1',
  parentID: 'ch-1',
  parentType: 'channel',
  authorID: 'u-1',
  body: 'hi',
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

function page(items: Message[], options: Partial<MessageWindow> = {}): InfiniteData<MessageWindow, MessagePageParam> {
  return {
    pages: [{
      items,
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: items[0]?.id,
      oldestID: items[items.length - 1]?.id,
      ...options,
    }],
    pageParams: [{ kind: 'tail' }],
  };
}

// Registers a channelMessages query whose CURRENT data is undefined, so
// the patch updater runs with `old === undefined` (the `!old` arm).
function withEmptyChannelQuery(qc: QueryClient, parentID: string) {
  const cache = qc.getQueryCache();
  cache.build(qc, { queryKey: queryKeys.channelMessages(parentID) });
}

describe('useMessages — defensive cache arms', () => {
  it('updateMessageInCache returns early when the query data is undefined', () => {
    const qc = new QueryClient();
    withEmptyChannelQuery(qc, 'ch-1');
    // No throw, no data created — the `!old` guard returned old (undefined).
    updateMessageInCache(qc, 'ch-1', msg({ id: 'm-1', body: 'new' }));
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1'))).toBeUndefined();
  });

  it('markMessageDeletedInCache returns early when the query data is undefined', () => {
    const qc = new QueryClient();
    withEmptyChannelQuery(qc, 'ch-1');
    markMessageDeletedInCache(qc, 'ch-1', 'm-1');
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1'))).toBeUndefined();
  });

  it('removeMessageFromCache returns early when the query data is undefined', () => {
    const qc = new QueryClient();
    withEmptyChannelQuery(qc, 'ch-1');
    removeMessageFromCache(qc, 'ch-1', 'm-1');
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1'))).toBeUndefined();
  });

  it('markMessageDeletedInCache leaves non-matching messages untouched and returns the same object when nothing changed', () => {
    const qc = new QueryClient();
    const original = page([msg({ id: 'm-1', body: 'keep' }), msg({ id: 'm-2', body: 'also keep' })]);
    qc.setQueryData(queryKeys.channelMessages('ch-1'), original);
    // Delete an id that exists → only m-1 is patched, m-2 hits the `: m`
    // identity arm (line 193).
    markMessageDeletedInCache(qc, 'ch-1', 'm-1');
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data?.pages[0].items[0].deleted).toBe(true);
    expect(data?.pages[0].items[1].body).toBe('also keep');
  });

  it('markMessageDeletedInCache returns the original data when no page contains the id (changed=false)', () => {
    const qc = new QueryClient();
    const original = page([msg({ id: 'm-1' })]);
    qc.setQueryData(queryKeys.channelMessages('ch-1'), original);
    // Deleting an id absent from all pages → changed stays false → the
    // `: old` arm of `changed ? … : old` (line 196) returns the same ref.
    markMessageDeletedInCache(qc, 'ch-1', 'absent-id');
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    expect(data).toBe(original);
  });

  it('catchUpTail tolerates the query disappearing before the fetch resolves (!old arm)', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), page([msg({ id: 'm-1' })]));
    apiFetchMock.mockImplementation(async () => {
      // Remove the query mid-flight so the setQueryData updater sees
      // old === undefined (catchUpTail line 258 `!old` guard).
      qc.removeQueries({ queryKey: queryKeys.channelMessages('ch-1') });
      return {
        items: [msg({ id: 'm-2', body: 'fresh' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
        newestID: 'm-2',
        oldestID: 'm-2',
      };
    });
    await resyncMessageCache(qc);
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1'))).toBeUndefined();
  });

  it('catchUpTail falls back through to head.newestID when the window omits newestID and fresh ids', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), page([msg({ id: 'm-1' })], { newestID: 'm-1' }));
    // window.newestID undefined AND the only fresh item's id is undefined
    // (nullish) → both earlier `??` arms are nullish, so newestID resolves
    // to head.newestID (line 266 third arm). Only a nullish id triggers it;
    // an empty string '' would short-circuit at the second arm.
    apiFetchMock.mockResolvedValue({
      items: [{ ...msg({ body: 'fresh-no-id' }), id: undefined } as unknown as Message],
      hasMoreOlder: false,
      hasMoreNewer: false,
    });
    await resyncMessageCache(qc);
    const data = qc.getQueryData<InfiniteData<MessageWindow>>(queryKeys.channelMessages('ch-1'));
    // The id-less fresh item is prepended; newestID stays head.newestID.
    expect(data?.pages[0].newestID).toBe('m-1');
  });
});
