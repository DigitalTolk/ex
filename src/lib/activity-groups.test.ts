import { describe, expect, it } from 'vitest';
import type { ActivityFeed, ActivityItem } from '@/types';
import {
  ACTIVITY_FILTERS,
  activityDay,
  activityTime,
  groupActivity,
  matchesFilter,
  unreadForFilter,
  withoutItems,
  withRead,
} from './activity-groups';

function item(over: Partial<ActivityItem> & Pick<ActivityItem, 'id' | 'type'>): ActivityItem {
  return {
    createdAt: '2026-10-06T10:00:00Z',
    messageID: `m-${over.id}`,
    parentID: 'ch-1',
    parentType: 'channel',
    read: false,
    ...over,
  };
}

describe('activity filters', () => {
  it('lists the five tabs in order', () => {
    expect(ACTIVITY_FILTERS.map((f) => f.key)).toEqual(['all', 'dms', 'mentions', 'threads', 'reactions']);
  });

  it('matches item types to tabs', () => {
    expect(matchesFilter('reminder', 'all')).toBe(true);
    expect(matchesFilter('dm', 'dms')).toBe(true);
    expect(matchesFilter('mention', 'dms')).toBe(false);
    expect(matchesFilter('thread_reply', 'threads')).toBe(true);
    expect(matchesFilter('reaction', 'reactions')).toBe(true);
    expect(matchesFilter('channel_added', 'mentions')).toBe(false);
  });

  it('counts unread per tab from the feed', () => {
    const feed = { unread: 5, unreadByType: { mention: 2, dm: 1, reaction: 2 } };
    expect(unreadForFilter(feed, 'all')).toBe(5);
    expect(unreadForFilter(feed, 'mentions')).toBe(2);
    expect(unreadForFilter(feed, 'threads')).toBe(0);
    expect(unreadForFilter({ unread: 0 }, 'dms')).toBe(0);
  });
});

describe('groupActivity', () => {
  it('folds replies in one thread, same-emoji reactions and one DM into single rows', () => {
    const rows = groupActivity([
      item({ id: 'a', type: 'thread_reply', parentMessageID: 'root', actorID: 'u-1' }),
      item({ id: 'b', type: 'mention', actorID: 'u-2' }),
      item({ id: 'c', type: 'thread_reply', parentMessageID: 'root', actorID: 'u-3', read: true }),
      item({ id: 'd', type: 'thread_reply', parentMessageID: 'root', actorID: 'u-1' }),
      item({ id: 'e', type: 'reaction', messageID: 'm-x', emoji: '🚀', actorID: 'u-4' }),
      item({ id: 'f', type: 'reaction', messageID: 'm-x', emoji: '🚀', actorID: 'u-5' }),
      item({ id: 'g', type: 'reaction', messageID: 'm-x', emoji: '👍', actorID: 'u-5' }),
      item({ id: 'h', type: 'dm', parentID: 'conv-1', parentType: 'conversation', actorID: 'u-6' }),
      item({ id: 'i', type: 'dm', parentID: 'conv-1', parentType: 'conversation', actorID: 'u-6', read: true }),
      item({ id: 'j', type: 'reminder' }),
    ]);
    expect(rows.map((r) => r.ids)).toEqual([['a', 'c', 'd'], ['b'], ['e', 'f'], ['g'], ['h', 'i'], ['j']]);
    const thread = rows[0];
    expect(thread.latest.id).toBe('a');
    expect(thread.actorIDs).toEqual(['u-1', 'u-3']);
    expect(thread.count).toBe(3);
    expect(thread.unread).toBe(true);
    // A reminder has no actor.
    expect(rows[5].actorIDs).toEqual([]);
  });

  it('groups a thread reply without a root by its own message', () => {
    const rows = groupActivity([item({ id: 'a', type: 'thread_reply' }), item({ id: 'b', type: 'thread_reply' })]);
    expect(rows).toHaveLength(2);
    // Reactions without an emoji still group by message.
    const reactions = groupActivity([item({ id: 'c', type: 'reaction', messageID: 'm' }), item({ id: 'd', type: 'reaction', messageID: 'm' })]);
    expect(reactions).toHaveLength(1);
  });

  it('marks a row read only when every item in it is read', () => {
    const rows = groupActivity([
      item({ id: 'a', type: 'dm', read: true }),
      item({ id: 'b', type: 'dm', read: true }),
      item({ id: 'c', type: 'reaction', read: true }),
    ]);
    expect(rows.map((r) => r.unread)).toEqual([false, false]);
  });
});

describe('activityDay', () => {
  const now = new Date(2026, 9, 6, 15, 0, 0);
  it('buckets by calendar day', () => {
    expect(activityDay(new Date(2026, 9, 6, 1, 0).toISOString(), now)).toBe('Today');
    expect(activityDay(new Date(2026, 9, 5, 23, 0).toISOString(), now)).toBe('Yesterday');
    expect(activityDay(new Date(2026, 9, 1, 12, 0).toISOString(), now)).toBe('Earlier');
    // Clock skew: a timestamp slightly in the future still counts as today.
    expect(activityDay(new Date(2026, 9, 7, 0, 30).toISOString(), now)).toBe('Today');
  });

  it('defaults to the current time', () => {
    expect(activityDay(new Date().toISOString())).toBe('Today');
    expect(activityTime(new Date().toISOString())).toMatch(/^\d\d:\d\d$/);
  });

  it('labels rows with a clock time, or a date once older than yesterday', () => {
    expect(activityTime(new Date(2026, 9, 6, 9, 5).toISOString(), now)).toBe('09:05');
    expect(activityTime(new Date(2026, 9, 5, 18, 30).toISOString(), now)).toBe('18:30');
    expect(activityTime(new Date(2026, 9, 2, 12, 0).toISOString(), now)).toBe('Oct 2');
  });
});

describe('optimistic feed updates', () => {
  const feed: ActivityFeed = {
    items: [
      item({ id: 'a', type: 'mention' }),
      item({ id: 'b', type: 'dm' }),
      item({ id: 'c', type: 'reaction', read: true }),
    ],
    unread: 2,
    unreadByType: { mention: 1, dm: 1 },
  };

  it('marks items read or unread and recounts', () => {
    const read = withRead(feed, ['a'], true);
    expect(read.items[0].read).toBe(true);
    expect(read.unread).toBe(1);
    expect(read.unreadByType).toEqual({ dm: 1 });
    const unread = withRead(feed, ['c'], false);
    expect(unread.unread).toBe(3);
    expect(unread.unreadByType).toEqual({ mention: 1, dm: 1, reaction: 1 });
  });

  it('removes items and recounts', () => {
    const left = withoutItems(feed, ['b']);
    expect(left.items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(left.unread).toBe(1);
    expect(left.unreadByType).toEqual({ mention: 1 });
  });
});
