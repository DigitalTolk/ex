import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  appendMessageToCache,
  updateMessageInCache,
  markMessageDeletedInCache,
  removeMessageFromCache,
  invalidateThreadBothScopes,
} from './useMessages';
import { queryKeys } from '@/lib/query-keys';
import type { Message } from '@/types';

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
