import { describe, it, expect } from 'vitest';
import {
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
  tabHasUnread,
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

  // A busy conversation or thread is one row, placed where its newest item is.
  it('groups DM messages per conversation and replies per thread', () => {
    const rows = groupActivity([
      item('d2', { type: 'dm', parentID: 'dm-1', parentType: 'conversation' }),
      item('m1'),
      item('t2', { type: 'thread_reply', parentMessageID: 'root-1', read: true }),
      item('d1', { type: 'dm', parentID: 'dm-1', parentType: 'conversation', read: true }),
      item('t1', { type: 'thread_reply', parentMessageID: 'root-1' }),
      item('t9', { type: 'thread_reply', parentMessageID: 'root-9' }),
      item('d9', { type: 'dm', parentID: 'dm-9', parentType: 'conversation' }),
      item('r1', { type: 'thread_reply' }),
    ]);
    expect(rows.map((r) => r.key)).toEqual([
      'dm:dm-1',
      'item:m1',
      'thread:ch-1|root-1',
      'thread:ch-1|root-9',
      'dm:dm-9',
      'thread:ch-1|',
    ]);
    expect(rows[0].lead.id).toBe('d2');
    expect(rows[0].items.map((i) => i.id)).toEqual(['d2', 'd1']);
    expect(rows[0].unreadIDs).toEqual(['d2']);
    expect(rows[2].unreadIDs).toEqual(['t1']);
  });

  it('filters by tab and reports unread per tab', () => {
    const items = [item('a'), item('b', { type: 'reminder' }), item('c', { type: 'dm', read: true })];
    expect(filterActivity(items, 'all')).toHaveLength(3);
    expect(filterActivity(items, 'mention').map((i) => i.id)).toEqual(['a']);
    const feed = withCounts(items);
    expect(tabHasUnread(feed, 'all')).toBe(true);
    expect(tabHasUnread(feed, 'mention')).toBe(true);
    expect(tabHasUnread(feed, 'dm')).toBe(false);
    expect(parseActivityTab('dm')).toBe('dm');
    expect(parseActivityTab('bogus')).toBe('all');
    expect(parseActivityTab(null)).toBe('all');
  });
});
