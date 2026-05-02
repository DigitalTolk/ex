import { describe, it, expect } from 'vitest';
import { collectMessageUserIDs, deriveThreadMeta, findLastOwnMessageId } from '@/lib/message-users';
import type { Message } from '@/types';

function msg(overrides: Partial<Message>): Message {
  return {
    id: 'm',
    parentID: 'p',
    authorID: 'u-author',
    body: '',
    createdAt: '2026-04-26T10:00:00Z',
    ...overrides,
  };
}

describe('collectMessageUserIDs', () => {
  it('returns just the authorID for a plain message', () => {
    expect(collectMessageUserIDs([msg({ authorID: 'u-1' })])).toEqual(['u-1']);
  });

  it('includes recent thread-reply authors', () => {
    const ids = collectMessageUserIDs([
      msg({ authorID: 'u-1', recentReplyAuthorIDs: ['u-2', 'u-3'] }),
    ]);
    expect(ids.sort()).toEqual(['u-1', 'u-2', 'u-3']);
  });

  it('includes every reactor across every emoji', () => {
    const ids = collectMessageUserIDs([
      msg({
        authorID: 'u-1',
        reactions: { ':+1:': ['u-2', 'u-3'], '🎉': ['u-4'] },
      }),
    ]);
    expect(ids.sort()).toEqual(['u-1', 'u-2', 'u-3', 'u-4']);
  });

  it('dedupes IDs that appear in multiple places', () => {
    const ids = collectMessageUserIDs([
      msg({
        authorID: 'u-1',
        recentReplyAuthorIDs: ['u-1', 'u-2'],
        reactions: { ':+1:': ['u-2', 'u-3'] },
      }),
    ]);
    expect(ids.sort()).toEqual(['u-1', 'u-2', 'u-3']);
  });

  it('walks every message in the iterable', () => {
    const ids = collectMessageUserIDs([
      msg({ authorID: 'u-1' }),
      msg({ authorID: 'u-2', reactions: { '❤️': ['u-3'] } }),
    ]);
    expect(ids.sort()).toEqual(['u-1', 'u-2', 'u-3']);
  });

  it('returns an empty array for no messages', () => {
    expect(collectMessageUserIDs([])).toEqual([]);
  });
});

describe('deriveThreadMeta', () => {
  it('captures lastReplyAt and a single-author list when one user replied once', () => {
    const meta = deriveThreadMeta([
      msg({ id: 'r1', parentMessageID: 'root', authorID: 'u-a', createdAt: '2026-04-26T10:00:00Z' }),
    ]);
    expect(meta.get('root')).toEqual({
      lastReplyAt: '2026-04-26T10:00:00Z',
      authors: ['u-a'],
    });
  });

  it('returns the most-recent timestamp across multiple replies', () => {
    const meta = deriveThreadMeta([
      msg({ id: 'r1', parentMessageID: 'root', authorID: 'u-a', createdAt: '2026-04-26T10:00:00Z' }),
      msg({ id: 'r2', parentMessageID: 'root', authorID: 'u-b', createdAt: '2026-04-26T11:00:00Z' }),
    ]);
    expect(meta.get('root')?.lastReplyAt).toBe('2026-04-26T11:00:00Z');
  });

  it('lists distinct authors most-recent first, capped at 3', () => {
    const meta = deriveThreadMeta([
      msg({ id: 'r1', parentMessageID: 'root', authorID: 'u-a', createdAt: '2026-04-26T10:00:00Z' }),
      msg({ id: 'r2', parentMessageID: 'root', authorID: 'u-b', createdAt: '2026-04-26T10:01:00Z' }),
      msg({ id: 'r3', parentMessageID: 'root', authorID: 'u-c', createdAt: '2026-04-26T10:02:00Z' }),
      msg({ id: 'r4', parentMessageID: 'root', authorID: 'u-d', createdAt: '2026-04-26T10:03:00Z' }),
    ]);
    expect(meta.get('root')?.authors).toEqual(['u-d', 'u-c', 'u-b']);
  });

  it('moves a repeat author to the front instead of duplicating', () => {
    const meta = deriveThreadMeta([
      msg({ id: 'r1', parentMessageID: 'root', authorID: 'u-a', createdAt: '2026-04-26T10:00:00Z' }),
      msg({ id: 'r2', parentMessageID: 'root', authorID: 'u-b', createdAt: '2026-04-26T10:01:00Z' }),
      msg({ id: 'r3', parentMessageID: 'root', authorID: 'u-a', createdAt: '2026-04-26T10:02:00Z' }),
    ]);
    expect(meta.get('root')?.authors).toEqual(['u-a', 'u-b']);
  });

  it('skips messages that are not replies', () => {
    const meta = deriveThreadMeta([msg({ id: 'r1', authorID: 'u-a' })]);
    expect(meta.size).toBe(0);
  });
});

describe('findLastOwnMessageId', () => {
  // Pages are newest-first; items within each page are also newest-first
  // (matches the API contract). Across-page case: the user's most recent
  // own message lives in pages[1] because pages[0] only has other people.
  it('returns the newest own top-level message in scope=main', () => {
    const pages = [
      { items: [
        msg({ id: 'm-9', authorID: 'u-other' }),
        msg({ id: 'm-8', authorID: 'u-other' }),
      ] },
      { items: [
        msg({ id: 'm-7', authorID: 'u-me' }),
        msg({ id: 'm-6', authorID: 'u-me' }),
      ] },
    ];
    expect(findLastOwnMessageId(pages, 'u-me', 'main')).toBe('m-7');
  });

  it('skips thread replies in scope=main', () => {
    const pages = [
      { items: [
        msg({ id: 'r-1', authorID: 'u-me', parentMessageID: 'root-1' }),
        msg({ id: 'm-5', authorID: 'u-me' }),
      ] },
    ];
    expect(findLastOwnMessageId(pages, 'u-me', 'main')).toBe('m-5');
  });

  it('skips system and deleted messages', () => {
    const pages = [
      { items: [
        msg({ id: 'sys', authorID: 'u-me', system: true }),
        msg({ id: 'tomb', authorID: 'u-me', deleted: true }),
        msg({ id: 'm-3', authorID: 'u-me' }),
      ] },
    ];
    expect(findLastOwnMessageId(pages, 'u-me', 'main')).toBe('m-3');
  });

  it('returns undefined when no own message is loaded', () => {
    const pages = [{ items: [msg({ id: 'm-1', authorID: 'u-other' })] }];
    expect(findLastOwnMessageId(pages, 'u-me', 'main')).toBeUndefined();
  });

  it('returns undefined when pages or currentUserId is missing', () => {
    expect(findLastOwnMessageId(undefined, 'u-me', 'main')).toBeUndefined();
    expect(findLastOwnMessageId([], undefined, 'main')).toBeUndefined();
  });

  it('with a thread scope, only returns replies under that root', () => {
    const pages = [
      { items: [
        msg({ id: 'm-top', authorID: 'u-me' }),
        msg({ id: 'r-other-thread', authorID: 'u-me', parentMessageID: 'root-2' }),
        msg({ id: 'r-mine', authorID: 'u-me', parentMessageID: 'root-1' }),
      ] },
    ];
    expect(findLastOwnMessageId(pages, 'u-me', 'root-1')).toBe('r-mine');
  });
});
