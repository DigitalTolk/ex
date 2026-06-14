import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  appendMessageToCache,
  updateMessageInCache,
  markMessageDeletedInCache,
  removeMessageFromCache,
  invalidateThreadBothScopes,
  resyncMessageCache,
} from './useMessages';
import { queryKeys } from '@/lib/query-keys';
import type { Message } from '@/types';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

beforeEach(() => {
  apiFetchMock.mockReset();
});

// Browser coverage for useMessages cache helpers (currently 63.82%).
// These are pure functions over the React Query cache so they don't
// need vitest-browser-react's render — but we still register them in
// a *.browser.test.ts file so the coverage instrumentation kicks in
// under the browser test pipeline.

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body: id,
    createdAt: '2026-05-01T10:00:00Z',
    ...over,
  };
}

function pageOf(messages: Message[], over: { hasMoreNewer?: boolean; newestID?: string } = {}) {
  return {
    items: messages,
    hasMoreNewer: false,
    hasMoreOlder: true,
    newestID: messages[0]?.id,
    ...over,
  };
}

describe('useMessages cache helpers', () => {
  it('appendMessageToCache prepends a new message to pages[0] when at tail', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m2'), msg('m1')])],
      pageParams: [null],
    });
    appendMessageToCache(qc, 'ch-1', msg('m3'));
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[]; newestID?: string }[] };
    expect(data.pages[0].items.map((m: Message) => m.id)).toEqual(['m3', 'm2', 'm1']);
    expect(data.pages[0].newestID).toBe('m3');
  });

  it('appendMessageToCache leaves the cache untouched when hasMoreNewer is true', () => {
    const qc = new QueryClient();
    const pages = [pageOf([msg('m2')], { hasMoreNewer: true })];
    qc.setQueryData(queryKeys.channelMessages('ch-1'), { pages, pageParams: [null] });
    appendMessageToCache(qc, 'ch-1', msg('m3'));
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[] }[] };
    expect(data.pages[0].items.map((m: Message) => m.id)).toEqual(['m2']);
  });

  it('appendMessageToCache skips a duplicate id', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1')])],
      pageParams: [null],
    });
    appendMessageToCache(qc, 'ch-1', msg('m1'));
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[] }[] };
    expect(data.pages[0].items.map((m: Message) => m.id)).toEqual(['m1']);
  });

  it('updateMessageInCache patches a matching message', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1'), msg('m2')])],
      pageParams: [null],
    });
    const patched = msg('m1', { body: 'updated body' });
    updateMessageInCache(qc, 'ch-1', patched);
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[] }[] };
    expect(data.pages[0].items.find((m: Message) => m.id === 'm1')?.body).toBe('updated body');
  });

  it('updateMessageInCache is a no-op when the message id is absent', () => {
    const qc = new QueryClient();
    const initial = { pages: [pageOf([msg('m1')])], pageParams: [null] };
    qc.setQueryData(queryKeys.channelMessages('ch-1'), initial);
    updateMessageInCache(qc, 'ch-1', msg('m-missing', { body: 'x' }));
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1'))).toEqual(initial);
  });

  it('markMessageDeletedInCache clears body/attachments/reactions but preserves id', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1', { body: 'original', attachmentIDs: ['a-1'], reactions: { '👍': ['u-2'] } })])],
      pageParams: [null],
    });
    markMessageDeletedInCache(qc, 'ch-1', 'm1');
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[] }[] };
    const after = data.pages[0].items.find((m: Message) => m.id === 'm1');
    expect(after?.deleted).toBe(true);
    expect(after?.body).toBe('');
    expect(after?.attachmentIDs).toEqual([]);
    expect(after?.reactions).toBeUndefined();
  });

  it('markMessageDeletedInCache patches thread caches too', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1')])],
      pageParams: [null],
    });
    qc.setQueryData(
      queryKeys.thread('channels/ch-1', 'm-root'),
      [msg('m1', { parentMessageID: 'm-root' })],
    );
    markMessageDeletedInCache(qc, 'ch-1', 'm1', 'm-root');
    const thread = qc.getQueryData(queryKeys.thread('channels/ch-1', 'm-root')) as Message[];
    expect(thread[0].deleted).toBe(true);
  });

  it('removeMessageFromCache filters a matching message out', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1'), msg('m2')])],
      pageParams: [null],
    });
    removeMessageFromCache(qc, 'ch-1', 'm1');
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[] }[] };
    expect(data.pages[0].items.map((m: Message) => m.id)).toEqual(['m2']);
  });

  it('removeMessageFromCache is a no-op for an unknown id', () => {
    const qc = new QueryClient();
    const initial = { pages: [pageOf([msg('m1')])], pageParams: [null] };
    qc.setQueryData(queryKeys.channelMessages('ch-1'), initial);
    removeMessageFromCache(qc, 'ch-1', 'm-missing');
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1'))).toEqual(initial);
  });

  it('invalidateThreadBothScopes invalidates the channel and conversation thread cache keys', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.thread('channels/ch-1', 'm-root'), [msg('m1', { parentMessageID: 'm-root' })]);
    qc.setQueryData(queryKeys.thread('conversations/ch-1', 'm-root'), [msg('m1', { parentMessageID: 'm-root' })]);
    invalidateThreadBothScopes(qc, 'ch-1', 'm-root');
    // Both queries are now invalidated; they remain in the cache but
    // are marked stale.
    expect(qc.getQueryState(queryKeys.thread('channels/ch-1', 'm-root'))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(queryKeys.thread('conversations/ch-1', 'm-root'))?.isInvalidated).toBe(true);
  });
});

describe('useMessages cache helpers — undefined / empty cache (no-op arms)', () => {
  // No query data set at all → every helper's `if (!old) return old`
  // arm fires (lines 133, 152, 186, 210). setQueriesData passes
  // `undefined` to the updater for a matching but empty key.
  it('appendMessageToCache is a no-op when no cache entry exists', () => {
    const qc = new QueryClient();
    expect(() => appendMessageToCache(qc, 'ch-x', msg('m1'))).not.toThrow();
    expect(qc.getQueryData(queryKeys.channelMessages('ch-x'))).toBeUndefined();
  });

  it('appendMessageToCache is a no-op for an empty pages array', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), { pages: [], pageParams: [] });
    appendMessageToCache(qc, 'ch-1', msg('m1'));
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: unknown[] };
    expect(data.pages.length).toBe(0);
  });

  it('updateMessageInCache is a no-op when no cache entry exists', () => {
    const qc = new QueryClient();
    expect(() => updateMessageInCache(qc, 'ch-x', msg('m1'))).not.toThrow();
  });

  it('removeMessageFromCache is a no-op when no cache entry exists', () => {
    const qc = new QueryClient();
    expect(() => removeMessageFromCache(qc, 'ch-x', 'm1')).not.toThrow();
  });

  it('markMessageDeletedInCache is a no-op when no cache entry exists', () => {
    const qc = new QueryClient();
    expect(() => markMessageDeletedInCache(qc, 'ch-x', 'm1')).not.toThrow();
  });
});

describe('useMessages markMessageDeletedInCache — page-walk + thread arms', () => {
  it('leaves non-matching pages untouched and patches the matching one', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      // pages[0] has no m1 (return p arm, line 189), pages[1] does (patch).
      pages: [pageOf([msg('other')]), pageOf([msg('m1', { body: 'gone' })])],
      pageParams: [null, null],
    });
    markMessageDeletedInCache(qc, 'ch-1', 'm1');
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[] }[] };
    expect(data.pages[0].items[0].id).toBe('other');
    expect(data.pages[1].items.find((m) => m.id === 'm1')?.deleted).toBe(true);
  });

  it('applies a patch override (custom author/createdAt) and leaves other thread messages alone', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1')])],
      pageParams: [null],
    });
    // Thread cache holds m1 plus a sibling that must be left untouched
    // (the `m.id === msgId ? ... : m` else arm, line 203).
    qc.setQueryData(queryKeys.thread('channels/ch-1', 'm-root'), [
      msg('m1', { parentMessageID: 'm-root' }),
      msg('sibling', { parentMessageID: 'm-root', body: 'keep me' }),
    ]);
    markMessageDeletedInCache(qc, 'ch-1', 'm1', 'm-root', { authorID: 'ghost', createdAt: '2099-01-01T00:00:00Z' });
    const thread = qc.getQueryData(queryKeys.thread('channels/ch-1', 'm-root')) as Message[];
    expect(thread.find((m) => m.id === 'm1')?.authorID).toBe('ghost');
    expect(thread.find((m) => m.id === 'sibling')?.body).toBe('keep me');
  });

  it('is a no-op on a thread cache that does not contain the deleted id', () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1')])],
      pageParams: [null],
    });
    // Thread cache exists but lacks m1 → `!old.some(...)` true arm.
    qc.setQueryData(queryKeys.thread('channels/ch-1', 'm-root'), [
      msg('elsewhere', { parentMessageID: 'm-root' }),
    ]);
    markMessageDeletedInCache(qc, 'ch-1', 'm1', 'm-root');
    const thread = qc.getQueryData(queryKeys.thread('channels/ch-1', 'm-root')) as Message[];
    expect(thread.map((m) => m.id)).toEqual(['elsewhere']);
  });
});

describe('useMessages resyncMessageCache — edge cases', () => {
  it('skips queries with empty pages and continues to the next', async () => {
    const qc = new QueryClient();
    // ch-empty: empty pages → `!data || pages.length === 0` continue (line 234).
    qc.setQueryData(queryKeys.channelMessages('ch-empty'), { pages: [], pageParams: [] });
    // ch-ok: tail-mode → fetched.
    qc.setQueryData(queryKeys.channelMessages('ch-ok'), {
      pages: [pageOf([msg('m1')])],
      pageParams: [null],
    });
    apiFetchMock.mockResolvedValue({
      items: [msg('m2', { body: 'fresh' })],
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: 'm2',
    });
    await resyncMessageCache(qc);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(apiFetchMock.mock.calls[0][0]).toMatch(/channels\/ch-ok\/messages\?after=m1/);
  });

  it('does not patch when the catch-up window returns no items', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1')])],
      pageParams: [null],
    });
    // Empty window → `window.items.length === 0` early return (line 256).
    apiFetchMock.mockResolvedValue({ items: [], hasMoreOlder: false, hasMoreNewer: false });
    await resyncMessageCache(qc);
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[] }[] };
    expect(data.pages[0].items.map((m) => m.id)).toEqual(['m1']);
  });

  it('does not patch when every fetched message is already present (all duplicates)', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1')])],
      pageParams: [null],
    });
    // Window only contains m1 which is already in head → fresh empty
    // (line 262 `fresh.length === 0` return).
    apiFetchMock.mockResolvedValue({
      items: [msg('m1')],
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: 'm1',
    });
    await resyncMessageCache(qc);
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as { pages: { items: Message[] }[] };
    expect(data.pages[0].items.map((m) => m.id)).toEqual(['m1']);
  });

  it('falls back to fresh[0]/head newestID when the window omits newestID + hasMoreNewer', async () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1')], { hasMoreNewer: false, newestID: 'm1' })],
      pageParams: [null],
    });
    // Window with fresh m2 but NO newestID and NO hasMoreNewer →
    // `window.newestID ?? fresh[0]?.id` (line 266) and
    // `window.hasMoreNewer ?? head.hasMoreNewer` (line 269) fallbacks.
    apiFetchMock.mockResolvedValue({
      items: [msg('m2', { body: 'fresh' })],
      hasMoreOlder: false,
    });
    await resyncMessageCache(qc);
    const data = qc.getQueryData(queryKeys.channelMessages('ch-1')) as {
      pages: { items: Message[]; newestID?: string; hasMoreNewer?: boolean }[];
    };
    expect(data.pages[0].items[0].id).toBe('m2');
    expect(data.pages[0].newestID).toBe('m2');
    expect(data.pages[0].hasMoreNewer).toBe(false);
  });

  it('skips a query whose newestID is missing even in tail mode', async () => {
    const qc = new QueryClient();
    // head.newestID undefined → `!head.newestID` continue (line 239).
    qc.setQueryData(queryKeys.channelMessages('ch-1'), {
      pages: [pageOf([msg('m1')], { newestID: undefined })],
      pageParams: [null],
    });
    await resyncMessageCache(qc);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('skips a query whose parentID slot in the key is empty', async () => {
    const qc = new QueryClient();
    // key[1] === '' → `!parentID` continue (line 241).
    qc.setQueryData(queryKeys.channelMessages('', null), {
      pages: [pageOf([msg('m1')])],
      pageParams: [null],
    });
    await resyncMessageCache(qc);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
