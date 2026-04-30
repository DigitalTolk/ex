import { describe, it, expect } from 'vitest';
import { queryKeys, parentPath } from './query-keys';

describe('queryKeys factory', () => {
  it('builds channelMessages with default null anchor (tail mode)', () => {
    expect(queryKeys.channelMessages('ch-1')).toEqual(['channelMessages', 'ch-1', null]);
  });

  it('embeds the deep-link anchor when provided', () => {
    expect(queryKeys.channelMessages('ch-1', 'msg-anchor')).toEqual([
      'channelMessages', 'ch-1', 'msg-anchor',
    ]);
  });

  it('channelMessagesAll omits the anchor segment for partial-match invalidation', () => {
    // setQueriesData / invalidateQueries with this 2-segment key matches
    // every cached anchor variant for the parent.
    expect(queryKeys.channelMessagesAll('ch-1')).toEqual(['channelMessages', 'ch-1']);
  });

  it('conversationMessages mirrors the channelMessages shape', () => {
    expect(queryKeys.conversationMessages('dm-1')).toEqual(['conversationMessages', 'dm-1', null]);
    expect(queryKeys.conversationMessagesAll('dm-1')).toEqual(['conversationMessages', 'dm-1']);
  });

  it('thread keys carry the parent path so channels and conversations don\'t collide', () => {
    expect(queryKeys.thread('channels/ch-1', 'm-root')).toEqual([
      'thread', 'channels/ch-1', 'm-root',
    ]);
  });

  it('list-style keys (userChannels etc.) take no args', () => {
    expect(queryKeys.userChannels()).toEqual(['userChannels']);
    expect(queryKeys.userConversations()).toEqual(['userConversations']);
    expect(queryKeys.userThreads()).toEqual(['userThreads']);
    expect(queryKeys.emojis()).toEqual(['emojis']);
  });

  it('browseChannels falls back to no-arg form for global invalidation', () => {
    expect(queryKeys.browseChannels()).toEqual(['browseChannels']);
    expect(queryKeys.browseChannels('eng')).toEqual(['browseChannels', 'eng']);
  });

  it('channelMembers with no arg matches every channel\'s members', () => {
    expect(queryKeys.channelMembers()).toEqual(['channelMembers']);
    expect(queryKeys.channelMembers('ch-1')).toEqual(['channelMembers', 'ch-1']);
  });
});

describe('parentPath', () => {
  it('returns channels/<id> when channelId is set', () => {
    expect(parentPath({ channelId: 'ch-1' })).toBe('channels/ch-1');
  });

  it('returns conversations/<id> when conversationId is set', () => {
    expect(parentPath({ conversationId: 'dm-1' })).toBe('conversations/dm-1');
  });
});
