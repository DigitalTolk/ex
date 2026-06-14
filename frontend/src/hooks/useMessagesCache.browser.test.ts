import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  appendMessageToCache,
  updateMessageInCache,
  markMessageDeletedInCache,
  removeMessageFromCache,
} from './useMessages';
import { queryKeys } from '@/lib/query-keys';
import type { Message } from '@/types';

// Direct coverage for the WebSocket-driven message-cache patch helpers. They
// are pure QueryClient mutations, only otherwise exercised via live WS events.

function msg(id: string, extra: Partial<Message> = {}): Message {
  return { id, parentID: 'ch-1', authorID: 'u-1', body: id, createdAt: '2026-05-01T10:00:00Z', ...extra };
}

function seed(qc: QueryClient, items: Message[], hasMoreNewer = false) {
  qc.setQueryData(queryKeys.channelMessages('ch-1', null), {
    pages: [{ items, hasMoreNewer, newestID: items[0]?.id }],
    pageParams: [undefined],
  });
}

function read(qc: QueryClient): Message[] {
  const data = qc.getQueryData(queryKeys.channelMessages('ch-1', null)) as
    | { pages: Array<{ items: Message[] }> }
    | undefined;
  return data?.pages[0]?.items ?? [];
}

describe('message cache patch helpers (browser)', () => {
  it('appendMessageToCache prepends a new message onto the live tail page', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1')]);
    appendMessageToCache(qc, 'ch-1', msg('m2'));
    expect(read(qc).map((m) => m.id)).toEqual(['m2', 'm1']);
  });

  it('appendMessageToCache leaves the chain untouched when the head still has newer pages', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1')], true);
    appendMessageToCache(qc, 'ch-1', msg('m2'));
    expect(read(qc).map((m) => m.id)).toEqual(['m1']);
  });

  it('appendMessageToCache ignores a duplicate id', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1')]);
    appendMessageToCache(qc, 'ch-1', msg('m1'));
    expect(read(qc).map((m) => m.id)).toEqual(['m1']);
  });

  it('appendMessageToCache is a no-op when no cache exists', () => {
    const qc = new QueryClient();
    appendMessageToCache(qc, 'ch-1', msg('m2'));
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1', null))).toBeUndefined();
  });

  it('updateMessageInCache replaces an existing message', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1', { body: 'old' })]);
    updateMessageInCache(qc, 'ch-1', msg('m1', { body: 'edited' }));
    expect(read(qc)[0].body).toBe('edited');
  });

  it('updateMessageInCache leaves the cache unchanged for an unknown id', () => {
    const qc = new QueryClient();
    const before = [msg('m1')];
    seed(qc, before);
    updateMessageInCache(qc, 'ch-1', msg('does-not-exist'));
    expect(read(qc).map((m) => m.id)).toEqual(['m1']);
  });

  it('markMessageDeletedInCache blanks the body and sets deleted, in list and thread', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1', { body: 'secret' })]);
    qc.setQueryData(queryKeys.thread('channels/ch-1', 'm1'), [msg('m1', { body: 'secret' })]);
    markMessageDeletedInCache(qc, 'ch-1', 'm1');
    expect(read(qc)[0]).toMatchObject({ deleted: true, body: '' });
    const thread = qc.getQueryData(queryKeys.thread('channels/ch-1', 'm1')) as Message[];
    expect(thread[0]).toMatchObject({ deleted: true, body: '' });
  });

  it('removeMessageFromCache drops the message from the page', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1'), msg('m2')]);
    removeMessageFromCache(qc, 'ch-1', 'm1');
    expect(read(qc).map((m) => m.id)).toEqual(['m2']);
  });

  it('removeMessageFromCache is a no-op for an unknown id', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1')]);
    removeMessageFromCache(qc, 'ch-1', 'nope');
    expect(read(qc).map((m) => m.id)).toEqual(['m1']);
  });

  // patchBothScopes patches both the channel- and conversation-keyed caches;
  // these seed the conversation scope to cover that second setQueriesData.
  function seedConv(qc: QueryClient, items: Message[], hasMoreNewer = false) {
    qc.setQueryData(queryKeys.conversationMessages('cv-1', null), {
      pages: [{ items, hasMoreNewer, newestID: items[0]?.id }],
      pageParams: [undefined],
    });
  }
  function readConv(qc: QueryClient): Message[] {
    const data = qc.getQueryData(queryKeys.conversationMessages('cv-1', null)) as
      | { pages: Array<{ items: Message[] }> }
      | undefined;
    return data?.pages[0]?.items ?? [];
  }

  it('appendMessageToCache patches the conversation-scope cache too', () => {
    const qc = new QueryClient();
    seedConv(qc, [msg('c1', { parentID: 'cv-1' })]);
    appendMessageToCache(qc, 'cv-1', msg('c2', { parentID: 'cv-1' }));
    expect(readConv(qc).map((m) => m.id)).toEqual(['c2', 'c1']);
  });

  it('updateMessageInCache is a no-op when no cache exists', () => {
    const qc = new QueryClient();
    updateMessageInCache(qc, 'ch-1', msg('m1', { body: 'x' }));
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1', null))).toBeUndefined();
  });

  it('removeMessageFromCache is a no-op when no cache exists', () => {
    const qc = new QueryClient();
    removeMessageFromCache(qc, 'ch-1', 'm1');
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1', null))).toBeUndefined();
  });

  it('markMessageDeletedInCache is a no-op on the list when no cache exists but still clears the thread', () => {
    const qc = new QueryClient();
    // No list cache; a thread copy exists and should still be blanked.
    qc.setQueryData(queryKeys.thread('channels/ch-1', 'root-1'), [msg('m1', { body: 'secret' })]);
    markMessageDeletedInCache(qc, 'ch-1', 'm1', 'root-1');
    expect(qc.getQueryData(queryKeys.channelMessages('ch-1', null))).toBeUndefined();
    const thread = qc.getQueryData(queryKeys.thread('channels/ch-1', 'root-1')) as Message[];
    expect(thread[0]).toMatchObject({ deleted: true, body: '' });
  });

  it('markMessageDeletedInCache leaves an absent thread copy untouched', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1', { body: 'secret' })]);
    // A thread for a DIFFERENT root must be left alone (the !some early return).
    qc.setQueryData(queryKeys.thread('channels/ch-1', 'm1'), [msg('other')]);
    markMessageDeletedInCache(qc, 'ch-1', 'm1');
    const thread = qc.getQueryData(queryKeys.thread('channels/ch-1', 'm1')) as Message[];
    expect(thread.map((m) => m.id)).toEqual(['other']);
  });

  it('markMessageDeletedInCache honours a supplied patch override', () => {
    const qc = new QueryClient();
    seed(qc, [msg('m1', { body: 'secret', authorID: 'u-1' })]);
    markMessageDeletedInCache(qc, 'ch-1', 'm1', undefined, { authorID: 'admin', createdAt: '2026-06-01T00:00:00Z' });
    expect(read(qc)[0]).toMatchObject({ deleted: true, body: '', authorID: 'admin', createdAt: '2026-06-01T00:00:00Z' });
  });
});
