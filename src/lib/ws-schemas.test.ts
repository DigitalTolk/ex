import { describe, it, expect } from 'vitest';
import {
  parseAttachmentDeleted,
  parseChannelID,
  parseMembersChanged,
  parseMessage,
  parseMessageDeleted,
  parsePresence,
  parseServerVersion,
  parseThreadUpdated,
  parseTyping,
  parseUserChannelUpdated,
  parseUserUpdated,
  payloadParser,
} from '@/test/ws-frames';

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

  it('parseMessageDeleted accepts the compact delete event payload', () => {
    expect(parseMessageDeleted({
      id: 'm-1',
      parentID: 'ch-1',
      parentMessageID: 'root-1',
    })).toMatchObject({
      id: 'm-1',
      parentID: 'ch-1',
      parentMessageID: 'root-1',
    });
    expect(parseMessageDeleted({ id: 'm-1', parentID: 'ch-1' })?.id).toBe('m-1');
    expect(parseMessageDeleted({ id: 'm-1' })).toBeNull();
  });

  it('parseTyping requires userID and parentID', () => {
    expect(parseTyping({ userID: 'u', parentID: 'p' })).toEqual({ userID: 'u', parentID: 'p' });
    expect(parseTyping({ userID: 'u' })).toBeNull();
  });

  it('parseTyping accepts an optional parentMessageID for thread typing', () => {
    expect(parseTyping({ userID: 'u', parentID: 'p', parentMessageID: 'm-1' })).toEqual({
      userID: 'u',
      parentID: 'p',
      parentMessageID: 'm-1',
    });
  });

  it('parseTyping rejects a non-string parentMessageID', () => {
    expect(parseTyping({ userID: 'u', parentID: 'p', parentMessageID: 0 })).toBeNull();
  });

  it('parseServerVersion requires a non-empty version', () => {
    expect(parseServerVersion({ version: 'abc' })?.version).toBe('abc');
    expect(parseServerVersion({ version: '' })).toBeNull();
    expect(parseServerVersion({ version: 0 })).toBeNull();
  });

  it('parseUserUpdated requires an id and passes through optional fields', () => {
    const ok = parseUserUpdated({ id: 'u-1', timeZone: 'UTC', lastSeenAt: '2026-01-01', userStatus: null });
    expect(ok?.id).toBe('u-1');
    expect(ok?.timeZone).toBe('UTC');
    expect(parseUserUpdated({ timeZone: 'UTC' })).toBeNull(); // missing id
    expect(parseUserUpdated({ id: '' })).toBeNull();
  });

  it('parseUserUpdated validates the directory fields (phone + manager)', () => {
    const ok = parseUserUpdated({
      id: 'u-1',
      phone: '+46 70 123 45 67',
      manager: { displayName: 'Boss', email: 'boss@example.com', userID: 'u-9' },
    });
    expect(ok?.phone).toBe('+46 70 123 45 67');
    expect(ok?.manager).toEqual({ displayName: 'Boss', email: 'boss@example.com', userID: 'u-9' });

    // A cleared manager arrives as explicit null.
    expect(parseUserUpdated({ id: 'u-1', manager: null })?.manager).toBeNull();
    // A malformed manager (no displayName) must not feed garbage into caches.
    expect(parseUserUpdated({ id: 'u-1', manager: { email: 'x@y.z' } })).toBeNull();
  });

  it('parseThreadUpdated accepts a full ThreadSummary and allows an empty rootBody', () => {
    const ok = parseThreadUpdated({
      parentID: 'ch-1',
      parentType: 'channel',
      threadRootID: 'root-1',
      rootAuthorID: 'u-2',
      rootBody: '',
      rootCreatedAt: '2026-05-01T10:00:00Z',
      replyCount: 3,
      latestActivityAt: '2026-05-01T10:05:00Z',
    });
    expect(ok).toMatchObject({ threadRootID: 'root-1', replyCount: 3, parentType: 'channel' });
  });

  it('parseThreadUpdated rejects a missing threadRootID, a bad parentType, and a non-numeric replyCount', () => {
    const base = {
      parentID: 'ch-1',
      parentType: 'channel',
      threadRootID: 'root-1',
      rootAuthorID: 'u-2',
      rootBody: 'hi',
      rootCreatedAt: '2026-05-01T10:00:00Z',
      replyCount: 1,
      latestActivityAt: '2026-05-01T10:05:00Z',
    };
    expect(parseThreadUpdated({ ...base, threadRootID: '' })).toBeNull();
    expect(parseThreadUpdated({ ...base, parentType: 'nope' })).toBeNull();
    expect(parseThreadUpdated({ ...base, replyCount: 'x' })).toBeNull();
  });
});

describe('parseUserChannelUpdated', () => {
  it('accepts every publisher shape (all fields optional)', () => {
    expect(parseUserChannelUpdated({ conversationID: 'c-1', updatedAt: '2026-07-02T10:00:00Z' })).toEqual(
      expect.objectContaining({ conversationID: 'c-1', updatedAt: '2026-07-02T10:00:00Z' }),
    );
    expect(parseUserChannelUpdated({ channelID: 'ch-1' })).toEqual(expect.objectContaining({ channelID: 'ch-1' }));
    expect(parseUserChannelUpdated({ userState: true })).toEqual(expect.objectContaining({ userState: true }));
    expect(parseUserChannelUpdated({ userID: 'u-1', categories: true })).toEqual(
      expect.objectContaining({ categories: true }),
    );
    expect(parseUserChannelUpdated({ channelID: 'ch-1', userID: 'u-1', favorite: false })).toEqual(
      expect.objectContaining({ favorite: false }),
    );
    expect(parseUserChannelUpdated({})).toEqual({});
  });

  it('rejects non-object and wrongly-typed payloads', () => {
    expect(parseUserChannelUpdated(undefined)).toBeNull();
    expect(parseUserChannelUpdated('nope')).toBeNull();
    expect(parseUserChannelUpdated({ channelID: 42 })).toBeNull();
    expect(parseUserChannelUpdated({ channelID: '' })).toBeNull();
  });
});

describe('activity, emoji, settings and agent-run payloads', () => {
  const parseActivityNew = payloadParser('activity.new');
  const parseActivityRead = payloadParser('activity.read');
  const parseEmojiAdded = payloadParser('emoji.added');
  const parseEmojiRemoved = payloadParser('emoji.removed');
  const parseSettings = payloadParser('notification.settings_updated');
  const parseRunUpdated = payloadParser('run.updated');
  const parseRunProgress = payloadParser('run.progress');
  const parseRunApproval = payloadParser('run.approval');
  const item = {
    id: 'a',
    type: 'mention',
    createdAt: '2026-10-08T10:00:00Z',
    messageID: 'm-a',
    parentID: 'ch-1',
    parentType: 'channel',
    read: false,
  };

  it('activity.new needs a whole item', () => {
    expect(parseActivityNew({ item })?.item.id).toBe('a');
    expect(parseActivityNew({ item: { id: 'a', type: 'mention' } })).toBeNull();
    expect(parseActivityNew({ item: { ...item, type: 'bogus' } })).toBeNull();
    expect(parseActivityNew({})).toBeNull();
    expect(parseActivityNew(null)).toBeNull();
  });

  it('activity.read takes any one change group, and rejects what is not one', () => {
    expect(parseActivityRead({ all: true })).toEqual({ all: true });
    expect(parseActivityRead({})).toEqual({});
    expect(parseActivityRead({ ids: 'a' })).toBeNull();
    expect(parseActivityRead('nope')).toBeNull();
    expect(parseActivityRead(null)).toBeNull();
  });

  it('emoji.added needs a name and image; emoji.removed a name', () => {
    expect(parseEmojiAdded({ name: 'party', imageURL: '/e/party.png' })).toEqual({
      name: 'party',
      imageURL: '/e/party.png',
      createdBy: '',
      createdAt: '',
    });
    expect(parseEmojiAdded({ name: 'nameless-url' })).toBeNull();
    expect(parseEmojiAdded({ name: '', imageURL: '/e/x.png' })).toBeNull();
    expect(parseEmojiRemoved({ name: 'party' })).toEqual({ name: 'party' });
    expect(parseEmojiRemoved({})).toBeNull();
  });

  it('notification.settings_updated needs the whole settings object', () => {
    const settings = {
      desktopLevel: 'all',
      mobileLevel: 'default',
      threadReplies: true,
      ignoreGroupMentions: false,
      followAllThreads: false,
    };
    expect(parseSettings({ userID: 'u-1', settings })?.settings).toEqual(settings);
    expect(parseSettings({ settings: { desktopLevel: 'all' } })).toBeNull();
    expect(parseSettings({ settings: { ...settings, desktopLevel: 'loud' } })).toBeNull();
  });

  it('run frames need the run, its agent and its parent', () => {
    expect(parseRunUpdated({ id: 'r1', agentID: 'a', parentID: 'ch-1', state: 'running', round: 2 })).toMatchObject({
      id: 'r1',
      round: 2,
    });
    expect(parseRunUpdated({ id: 'r1', agentID: 'a', parentID: 'ch-1' })).toBeNull();
    expect(parseRunProgress({ runID: 'r1', agentID: 'a', parentID: 'ch-1', kind: 'text', text: 'hi' })?.text).toBe('hi');
    expect(parseRunProgress({ runID: 'r1', parentID: 'ch-1' })).toBeNull();
  });

  it('run.approval needs its id and parent, and takes a nil options slice', () => {
    expect(parseRunApproval({ approvalID: 'ap-1', parentID: 'ch-1', options: null })?.options).toBeNull();
    expect(parseRunApproval({ approvalID: 'ap-1', parentID: 'ch-1', options: ['a', 'b'] })?.options).toEqual(['a', 'b']);
    expect(parseRunApproval({ approvalID: 'ap-1' })).toBeNull();
    expect(parseRunApproval({ parentID: 'ch-1' })).toBeNull();
  });
});
