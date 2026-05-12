import { describe, expect, it, vi } from 'vitest';
import { collectMessageUserIDs, findLastOwnMessageId, deriveThreadMeta } from './message-users';
import { queryKeys, parentPath } from './query-keys';
import { cn, isHttpUrl } from './utils';
import { activeStatus, formatStatusUntil } from './user-status';
import { setWSSender, sendWS } from './ws-sender';
import type { Message, UserStatus } from '@/types';

// Pure library coverage — every branch in these utility modules is
// reachable from the browser bundle and merits a test.

const msg = (overrides: Partial<Message> = {}): Message => ({
  id: 'm-1',
  parentID: 'ch-1',
  parentType: 'channel',
  authorID: 'u-1',
  body: 'hi',
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

describe('message-users.collectMessageUserIDs', () => {
  it('collects authors, reply authors, and reactors into a deduplicated list', () => {
    const ids = collectMessageUserIDs([
      msg({ authorID: 'u-1', recentReplyAuthorIDs: ['u-2'], reactions: { ':+1:': ['u-3', 'u-1'] } }),
      msg({ authorID: 'u-2', recentReplyAuthorIDs: ['u-4'] }),
    ]);
    expect(new Set(ids)).toEqual(new Set(['u-1', 'u-2', 'u-3', 'u-4']));
  });

  it('handles messages with no reactions or replies', () => {
    expect(collectMessageUserIDs([msg({ authorID: 'u-a' })])).toEqual(['u-a']);
  });
});

describe('message-users.findLastOwnMessageId', () => {
  it('returns the most recent own top-level message in main scope', () => {
    const pages = [
      { items: [msg({ id: 'm-1', authorID: 'u-1' }), msg({ id: 'm-2', authorID: 'u-2' })] },
    ];
    expect(findLastOwnMessageId(pages, 'u-1', 'main')).toBe('m-1');
  });

  it('skips deleted, system, and reply messages in main scope', () => {
    const pages = [
      { items: [
        msg({ id: 'd-1', deleted: true }),
        msg({ id: 's-1', system: true }),
        msg({ id: 't-1', parentMessageID: 'root' }),
        msg({ id: 'm-3' }),
      ] },
    ];
    expect(findLastOwnMessageId(pages, 'u-1', 'main')).toBe('m-3');
  });

  it('filters by threadID when scope is a thread root', () => {
    const pages = [
      { items: [
        msg({ id: 't-2', parentMessageID: 'other-root' }),
        msg({ id: 't-1', parentMessageID: 'root' }),
      ] },
    ];
    expect(findLastOwnMessageId(pages, 'u-1', 'root')).toBe('t-1');
  });

  it('returns undefined when no user, no pages, or no match', () => {
    expect(findLastOwnMessageId(undefined, 'u-1', 'main')).toBeUndefined();
    expect(findLastOwnMessageId([{ items: [] }], undefined, 'main')).toBeUndefined();
    expect(findLastOwnMessageId([{ items: [msg({ authorID: 'u-2' })] }], 'u-1', 'main')).toBeUndefined();
  });
});

describe('message-users.deriveThreadMeta', () => {
  it('aggregates per-thread last reply timestamp and up to 3 distinct authors', () => {
    const replies = [
      msg({ id: 'r-1', parentMessageID: 'root-1', authorID: 'u-1', createdAt: '2026-01-02T00:00:00Z' }),
      msg({ id: 'r-2', parentMessageID: 'root-1', authorID: 'u-2', createdAt: '2026-01-03T00:00:00Z' }),
      msg({ id: 'r-3', parentMessageID: 'root-1', authorID: 'u-1', createdAt: '2026-01-01T00:00:00Z' }),
      msg({ id: 'r-4', parentMessageID: 'root-1', authorID: 'u-3', createdAt: '2026-01-04T00:00:00Z' }),
      msg({ id: 'r-5', parentMessageID: 'root-1', authorID: 'u-4', createdAt: '2026-01-05T00:00:00Z' }),
      msg({ id: 'top', authorID: 'u-9' }),
    ];
    const meta = deriveThreadMeta(replies);
    const entry = meta.get('root-1')!;
    expect(entry.lastReplyAt).toBe('2026-01-05T00:00:00Z');
    expect(entry.authors.length).toBe(3);
    expect(entry.authors[0]).toBe('u-4');
  });
});

describe('query-keys', () => {
  it('builds stable shapes for each known query', () => {
    expect(queryKeys.user('u-1')).toEqual(['user', 'u-1']);
    expect(queryKeys.usersBatch()).toEqual(['users-batch']);
    expect(queryKeys.usersBatch(['u-1', 'u-2'])).toEqual(['users-batch', ['u-1', 'u-2']]);
    expect(queryKeys.channelBySlug()).toEqual(['channelBySlug']);
    expect(queryKeys.channelBySlug('general')).toEqual(['channelBySlug', 'general']);
    expect(queryKeys.browseChannels()).toEqual(['browseChannels']);
    expect(queryKeys.browseChannels('foo')).toEqual(['browseChannels', 'foo']);
    expect(queryKeys.channelMembers()).toEqual(['channelMembers']);
    expect(queryKeys.channelMembers('ch-1')).toEqual(['channelMembers', 'ch-1']);
    expect(queryKeys.channelMessages('ch-1')[2]).toBeNull();
    expect(queryKeys.channelMessages('ch-1', 'anchor-1')[2]).toBe('anchor-1');
    expect(queryKeys.channelMessagesAll('ch-1')).toEqual(['channelMessages', 'ch-1']);
    expect(queryKeys.conversationMessagesAll('cv-1')).toEqual(['conversationMessages', 'cv-1']);
  });

  it('parentPath prefers channelId when set', () => {
    expect(parentPath({ channelId: 'ch-1' })).toBe('channels/ch-1');
    expect(parentPath({ conversationId: 'cv-1' })).toBe('conversations/cv-1');
  });
});

describe('utils.cn / isHttpUrl', () => {
  it('cn merges Tailwind classes with twMerge semantics', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('flex', undefined, false, 'gap-2')).toContain('flex');
  });

  it('isHttpUrl whitelists http/https only', () => {
    expect(isHttpUrl('https://example.org')).toBe(true);
    expect(isHttpUrl('http://example.org')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/plain;base64,Zm9v')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('https://example.org with spaces')).toBe(false);
  });
});

describe('user-status', () => {
  it('activeStatus returns the status only when both emoji and text are set', () => {
    const s: UserStatus = { emoji: ':smile:', text: 'busy' };
    expect(activeStatus(s)).toBe(s);
    expect(activeStatus({ emoji: '', text: 'busy' } as UserStatus)).toBeNull();
    expect(activeStatus({ emoji: ':x:', text: '' } as UserStatus)).toBeNull();
    expect(activeStatus(null)).toBeNull();
    expect(activeStatus(undefined)).toBeNull();
  });

  it('formatStatusUntil returns "won\'t clear" for no input, the date string otherwise', () => {
    expect(formatStatusUntil()).toMatch(/won't clear/);
    expect(formatStatusUntil('2026-04-01T12:00:00Z')).toMatch(/until/);
  });
});

describe('ws-sender', () => {
  it('sendWS is a no-op when no sender is installed', () => {
    setWSSender(null);
    expect(() => sendWS({ type: 'ping' })).not.toThrow();
  });

  it('sendWS serialises the payload and calls the installed sender', () => {
    const fn = vi.fn();
    setWSSender(fn);
    sendWS({ type: 'ping', n: 1 });
    expect(fn).toHaveBeenCalledWith(JSON.stringify({ type: 'ping', n: 1 }));
    setWSSender(null);
  });

  it('sendWS swallows JSON.stringify errors from circular payloads', () => {
    const fn = vi.fn();
    setWSSender(fn);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sendWS(circular)).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
    setWSSender(null);
  });
});
