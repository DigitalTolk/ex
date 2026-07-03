import { describe, expect, it } from 'vitest';
import {
  parseMessage,
  parseMessageDeleted,
  parseChannelID,
  parsePresence,
  parseAttachmentDeleted,
  parseTyping,
  parseServerVersion,
  parseMembersChanged,
  parseThreadUpdated,
} from './ws-schemas';

describe('ws-schemas — parser branches', () => {
  it('parseMessage accepts a minimum-shape payload', () => {
    const out = parseMessage({
      id: 'm-1',
      parentID: 'ch-1',
      authorID: 'u-1',
      body: 'hi',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(out?.id).toBe('m-1');
  });

  it('parseMessage preserves passthrough fields (rendered tree, attachments, reactions)', () => {
    const out = parseMessage({
      id: 'm-1',
      parentID: 'ch-1',
      authorID: 'u-1',
      body: 'hi',
      createdAt: '2026-01-01T00:00:00Z',
      rendered: { type: 'root', children: [] },
      attachmentIDs: ['a-1'],
      reactions: { ':+1:': ['u-2'] },
    });
    expect(out).not.toBeNull();
    expect((out as { rendered?: unknown }).rendered).toBeDefined();
  });

  it('parseMessage returns null on missing required fields', () => {
    expect(parseMessage({ id: '', parentID: 'ch', authorID: 'u', body: 'b', createdAt: 'c' })).toBeNull();
    expect(parseMessage({})).toBeNull();
    expect(parseMessage(null)).toBeNull();
  });

  it('parseMessageDeleted requires id and parentID, accepts optional parentMessageID', () => {
    expect(parseMessageDeleted({ id: 'm-1', parentID: 'ch-1' })).toEqual({ id: 'm-1', parentID: 'ch-1' });
    expect(parseMessageDeleted({ id: 'm-1', parentID: 'ch-1', parentMessageID: 'root-1' })?.parentMessageID).toBe('root-1');
    expect(parseMessageDeleted({ id: '', parentID: 'ch-1' })).toBeNull();
  });

  it('parseChannelID / parseMembersChanged require a non-empty channelID', () => {
    expect(parseChannelID({ channelID: 'ch-1' })).toEqual({ channelID: 'ch-1' });
    expect(parseChannelID({ channelID: '' })).toBeNull();
    expect(parseMembersChanged({ channelID: 'ch-2' })).toEqual({ channelID: 'ch-2' });
  });

  it('parsePresence requires userID and a boolean online flag', () => {
    expect(parsePresence({ userID: 'u-1', online: true })).toEqual({ userID: 'u-1', online: true });
    expect(parsePresence({ userID: 'u-1', online: 'yes' })).toBeNull();
    expect(parsePresence({})).toBeNull();
  });

  it('parseAttachmentDeleted requires a non-empty id', () => {
    expect(parseAttachmentDeleted({ id: 'a-1' })).toEqual({ id: 'a-1' });
    expect(parseAttachmentDeleted({ id: '' })).toBeNull();
  });

  it('parseTyping accepts main-list typing (no parentMessageID) and thread typing', () => {
    expect(parseTyping({ userID: 'u-1', parentID: 'ch-1' })).toEqual({
      userID: 'u-1',
      parentID: 'ch-1',
    });
    expect(parseTyping({ userID: 'u-1', parentID: 'ch-1', parentMessageID: 'root-1' })?.parentMessageID).toBe('root-1');
    expect(parseTyping({})).toBeNull();
  });

  it('parseServerVersion requires version', () => {
    expect(parseServerVersion({ version: '1.2.3' })).toEqual({ version: '1.2.3' });
    expect(parseServerVersion({ version: '' })).toBeNull();
  });

  it('parseThreadUpdated validates the ThreadSummary shape', () => {
    const ok = {
      parentID: 'ch-1',
      parentType: 'channel',
      threadRootID: 'root-1',
      rootAuthorID: 'u-2',
      rootBody: 'hi',
      rootCreatedAt: '2026-05-01T10:00:00Z',
      replyCount: 2,
      latestActivityAt: '2026-05-01T10:05:00Z',
    };
    expect(parseThreadUpdated(ok)).toMatchObject({ threadRootID: 'root-1', replyCount: 2 });
    expect(parseThreadUpdated({ ...ok, threadRootID: '' })).toBeNull();
    expect(parseThreadUpdated({ ...ok, parentType: 'nope' })).toBeNull();
    expect(parseThreadUpdated({})).toBeNull();
  });
});
