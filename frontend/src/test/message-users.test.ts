import { describe, it, expect } from 'vitest';
import { collectMessageUserIDs, deriveThreadMeta } from '@/lib/message-users';
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
