import { describe, it, expect } from 'vitest';
import {
  parseAttachmentDeleted,
  parseChannelID,
  parseMembersChanged,
  parseMessage,
  parsePresence,
  parseServerVersion,
  parseTyping,
} from './ws-schemas';

describe('parseMessage', () => {
  const valid = {
    id: 'm-1',
    parentID: 'ch-1',
    authorID: 'u-1',
    body: 'hi',
    createdAt: '2026-04-30T10:00:00Z',
  };

  it('accepts a minimum-shape Message', () => {
    expect(parseMessage(valid)).toMatchObject(valid);
  });

  it('accepts an empty body string (system messages can have just attachments)', () => {
    expect(parseMessage({ ...valid, body: '' })?.body).toBe('');
  });

  it('returns null for non-objects', () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage(undefined)).toBeNull();
    expect(parseMessage('hi')).toBeNull();
    expect(parseMessage([])).toBeNull();
  });

  it.each(['id', 'parentID', 'authorID', 'createdAt'] as const)(
    'returns null when %s is missing',
    (key) => {
      const partial = { ...valid };
      delete (partial as Record<string, unknown>)[key];
      expect(parseMessage(partial)).toBeNull();
    },
  );

  it('returns null when replyCount is not a number', () => {
    expect(parseMessage({ ...valid, replyCount: 'two' })).toBeNull();
  });

  it('returns null when parentMessageID is non-string', () => {
    expect(parseMessage({ ...valid, parentMessageID: 0 })).toBeNull();
  });

  it('preserves optional fields the cache patchers read', () => {
    const parsed = parseMessage({
      ...valid,
      replyCount: 3,
      recentReplyAuthorIDs: ['u-2', 'u-3'],
      lastReplyAt: '2026-04-30T11:00:00Z',
      pinned: true,
      reactions: { '👍': ['u-1'] },
    });
    expect(parsed?.replyCount).toBe(3);
    expect(parsed?.recentReplyAuthorIDs).toEqual(['u-2', 'u-3']);
    expect(parsed?.pinned).toBe(true);
    expect(parsed?.reactions).toEqual({ '👍': ['u-1'] });
  });
});

describe('event payload parsers', () => {
  it('parseMembersChanged / parseChannelID share the channelID shape', () => {
    expect(parseMembersChanged({ channelID: 'ch-1' })?.channelID).toBe('ch-1');
    expect(parseChannelID({ channelID: 'ch-1' })?.channelID).toBe('ch-1');
    expect(parseMembersChanged({})).toBeNull();
    expect(parseMembersChanged(null)).toBeNull();
  });

  it('parsePresence requires userID + boolean online', () => {
    expect(parsePresence({ userID: 'u', online: true })).toEqual({ userID: 'u', online: true });
    expect(parsePresence({ userID: 'u', online: 'yes' })).toBeNull();
    expect(parsePresence({ userID: 'u' })).toBeNull();
  });

  it('parseAttachmentDeleted requires id', () => {
    expect(parseAttachmentDeleted({ id: 'a-1' })?.id).toBe('a-1');
    expect(parseAttachmentDeleted({})).toBeNull();
  });

  it('parseTyping requires userID and parentID', () => {
    expect(parseTyping({ userID: 'u', parentID: 'p' })).toEqual({ userID: 'u', parentID: 'p' });
    expect(parseTyping({ userID: 'u' })).toBeNull();
  });

  it('parseServerVersion requires a non-empty version', () => {
    expect(parseServerVersion({ version: 'abc' })?.version).toBe('abc');
    expect(parseServerVersion({ version: '' })).toBeNull();
    expect(parseServerVersion({ version: 0 })).toBeNull();
  });
});
