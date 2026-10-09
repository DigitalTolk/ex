import { describe, it, expect } from 'vitest';
import {
  activityHref,
  activitySections,
  activityTime,
  addActivityItem,
  applyActivityChange,
  filterActivity,
  groupActivity,
  markActivityItems,
  markAllActivityRead,
  parseActivityChange,
  parseActivityNew,
  parseActivityTab,
  removeActivityItems,
  isWebhookItem,
  tabUnread,
  withCounts,
} from './activity-feed';
import type { ActivityItem } from '@/types';

function item(id: string, over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    type: 'mention',
    createdAt: '2026-10-08T10:00:00Z',
    messageID: `m-${id}`,
    parentID: 'ch-1',
    parentType: 'channel',
    read: false,
    ...over,
  };
}

describe('activity feed helpers', () => {
  it('derives the unread totals from the items', () => {
    const feed = withCounts([item('a'), item('b', { type: 'dm' }), item('c', { read: true })]);
    expect(feed.unread).toBe(2);
    expect(feed.unreadByType).toEqual({ mention: 1, dm: 1 });
  });

  it('marks everything, some items, or removes items — counts follow', () => {
    const feed = withCounts([item('a'), item('b'), item('c', { read: true })]);
    expect(markAllActivityRead(feed).unread).toBe(0);
    const marked = markActivityItems(feed, ['a', 'c'], false);
    expect(marked.items.map((i) => i.read)).toEqual([false, false, false]);
    expect(marked.unread).toBe(3);
    const removed = removeActivityItems(feed, ['b']);
    expect(removed.items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(removed.unread).toBe(1);
  });

  it('adds a new item on top, once', () => {
    const feed = withCounts([item('a', { read: true })]);
    const next = addActivityItem(feed, item('b'));
    expect(next.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(next.unread).toBe(1);
    expect(addActivityItem(next, item('b'))).toBe(next);
  });

  it('applies the changes it can and defers the rest to the server', () => {
    const feed = withCounts([item('a'), item('b')]);
    expect(applyActivityChange(feed, { all: true })?.unread).toBe(0);
    expect(applyActivityChange(feed, { ids: ['a'], read: true })?.unread).toBe(1);
    expect(applyActivityChange(feed, { removed: ['a'] })?.items).toHaveLength(1);
    // A read of part of a parent, an edit, or an id list without a direction
    // can only be resolved by refetching.
    expect(applyActivityChange(feed, { parentID: 'ch-1' })).toBeNull();
    expect(applyActivityChange(feed, { updated: ['a'] })).toBeNull();
    expect(applyActivityChange(feed, { ids: ['a'] })).toBeNull();
  });

  it('parses event payloads defensively', () => {
    expect(parseActivityNew({ item: item('a') })?.id).toBe('a');
    expect(parseActivityNew({ item: { id: 'a' } })).toBeNull();
    expect(parseActivityNew({})).toBeNull();
    expect(parseActivityNew(null)).toBeNull();
    expect(parseActivityChange({ all: true })).toEqual({ all: true });
    expect(parseActivityChange('nope')).toEqual({});
    expect(parseActivityChange(null)).toEqual({});
  });

  // A busy conversation or thread is one row, placed where its newest item is;
  // so is the same emoji on one message.
  it('groups DM messages per conversation, replies per thread and reactions per emoji', () => {
    const rows = groupActivity([
      item('d2', { type: 'dm', parentID: 'dm-1', parentType: 'conversation', actorID: 'u-b' }),
      item('m1', { actorID: 'u-a' }),
      item('t2', { type: 'thread_reply', parentMessageID: 'root-1', read: true, actorID: 'u-a' }),
      item('d1', { type: 'dm', parentID: 'dm-1', parentType: 'conversation', read: true, actorID: 'u-c' }),
      item('t1', { type: 'thread_reply', parentMessageID: 'root-1', actorID: 'u-a' }),
      item('t9', { type: 'thread_reply', parentMessageID: 'root-9' }),
      item('x2', { type: 'reaction', messageID: 'm-7', emoji: '🎉', actorID: 'u-a' }),
      item('x1', { type: 'reaction', messageID: 'm-7', emoji: '🎉', actorID: 'webhook', webhook: true }),
      item('x3', { type: 'reaction', messageID: 'm-7', emoji: '👍' }),
      item('r1', { type: 'thread_reply', messageID: 'm-r1' }),
    ]);
    expect(rows.map((r) => r.key)).toEqual([
      'dm:dm-1',
      'item:m1',
      'thread:ch-1|root-1',
      'thread:ch-1|root-9',
      'reaction:m-7|🎉',
      'reaction:m-7|👍',
      // A reply without its root still groups with itself, never with another
      // rootless reply.
      'thread:ch-1|m-r1',
    ]);
    expect(rows[0].lead.id).toBe('d2');
    expect(rows[0].items.map((i) => i.id)).toEqual(['d2', 'd1']);
    expect(rows[0].unreadIDs).toEqual(['d2']);
    expect(rows[0].actorIDs).toEqual(['u-b', 'u-c']);
    expect(rows[2].unreadIDs).toEqual(['t1']);
    // Each actor once; a webhook is never one of the people.
    expect(rows[2].actorIDs).toEqual(['u-a']);
    expect(rows[4].actorIDs).toEqual(['u-a']);
  });

  it('flags webhook items, including ones from before the flag existed', () => {
    expect(isWebhookItem(item('a', { webhook: true }))).toBe(true);
    expect(isWebhookItem(item('a', { actorName: 'Deploy Bot' }))).toBe(true);
    expect(isWebhookItem(item('a'))).toBe(false);
  });

  it('filters by tab and counts unread per tab', () => {
    const items = [item('a'), item('b', { type: 'reminder' }), item('c', { type: 'dm', read: true })];
    expect(filterActivity(items, 'all')).toHaveLength(3);
    expect(filterActivity(items, 'mention').map((i) => i.id)).toEqual(['a']);
    const feed = withCounts(items);
    expect(tabUnread(feed, 'all')).toBe(2);
    expect(tabUnread(feed, 'mention')).toBe(1);
    expect(tabUnread(feed, 'dm')).toBe(0);
    expect(parseActivityTab('dm')).toBe('dm');
    expect(parseActivityTab('bogus')).toBe('all');
    expect(parseActivityTab(null)).toBe('all');
  });

  it('buckets rows by calendar day into consecutive sections', () => {
    const now = new Date(2026, 9, 9, 12, 0);
    const at = (d: Date) => d.toISOString();
    const dayOf = (d: Date) => activitySections(groupActivity([item('x', { createdAt: at(d) })]), now)[0].day;
    expect(dayOf(new Date(2026, 9, 9, 0, 5))).toBe('Today');
    expect(dayOf(new Date(2026, 9, 10, 9, 0))).toBe('Today');
    expect(dayOf(new Date(2026, 9, 8, 23, 59))).toBe('Yesterday');
    expect(dayOf(new Date(2026, 9, 1))).toBe('Earlier');

    const rows = groupActivity([
      item('a', { createdAt: at(new Date(2026, 9, 9, 11)) }),
      item('b', { createdAt: at(new Date(2026, 9, 9, 8)) }),
      item('c', { createdAt: at(new Date(2026, 9, 8, 8)) }),
      item('d', { createdAt: at(new Date(2026, 8, 1)) }),
    ]);
    expect(activitySections(rows, now).map((s) => [s.day, s.rows.map((r) => r.lead.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Earlier', ['d']],
    ]);
  });

  it('labels a row with the clock time for recent days and the date before that, in the reader locale', () => {
    const now = new Date(2026, 9, 9, 12, 0);
    const today = new Date(2026, 9, 9, 9, 5);
    const old = new Date(2026, 8, 1, 9, 5);
    expect(activityTime(today.toISOString(), now)).toBe(
      new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(today),
    );
    expect(activityTime(old.toISOString(), now)).toBe(
      new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(old),
    );
  });

  // A channel resolves by id first: after a rename the snapshot slug may now
  // name a different channel.
  it('links rows and reminders to their message, opening threads, by channel id first', () => {
    const slugs = new Map([['ch-1', 'renamed']]);
    expect(activityHref(item('a', { channelSlug: 'old-name' }), slugs)).toBe('/channel/renamed#msg-m-a');
    expect(activityHref(item('a', { parentID: 'ch-9', channelSlug: 'kept' }), slugs)).toBe('/channel/kept#msg-m-a');
    expect(activityHref(item('a', { parentID: 'ch-9' }), slugs)).toBe('/channel/ch-9#msg-m-a');
    expect(activityHref(item('a', { parentMessageID: 'root-1' }), slugs)).toBe('/channel/renamed?thread=root-1#msg-m-a');
    expect(activityHref(item('a', { parentID: 'dm-1', parentType: 'conversation' }), slugs)).toBe('/conversation/dm-1#msg-m-a');
  });
});
