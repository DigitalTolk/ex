import type { ActivityChangedEvent, ActivityFeed, ActivityItem, ActivityType } from '@/types';

// withCounts rebuilds a feed from its items, deriving the unread totals from
// the rows themselves so a patched cache can never disagree with its own list.
export function withCounts(items: ActivityItem[]): ActivityFeed {
  const unreadByType: Partial<Record<ActivityType, number>> = {};
  let unread = 0;
  for (const i of items) {
    if (i.read) continue;
    unread++;
    unreadByType[i.type] = (unreadByType[i.type] ?? 0) + 1;
  }
  return { items, unread, unreadByType };
}

export function markAllActivityRead(feed: ActivityFeed): ActivityFeed {
  return withCounts(feed.items.map((i) => (i.read ? i : { ...i, read: true })));
}

export function markActivityItems(feed: ActivityFeed, ids: string[], read: boolean): ActivityFeed {
  const set = new Set(ids);
  return withCounts(feed.items.map((i) => (set.has(i.id) ? { ...i, read } : i)));
}

export function removeActivityItems(feed: ActivityFeed, ids: string[]): ActivityFeed {
  const set = new Set(ids);
  return withCounts(feed.items.filter((i) => !set.has(i.id)));
}

// addActivityItem puts a newly arrived item (activity.new) at the top, where
// the server lists it too. A repeated delivery of the same item is a no-op.
export function addActivityItem(feed: ActivityFeed, item: ActivityItem): ActivityFeed {
  if (feed.items.some((i) => i.id === item.id)) return feed;
  return withCounts([item, ...feed.items]);
}

// applyActivityChange applies an activity.read change to the feed. It returns
// null when only the server can say what changed — reading part of a channel,
// conversation or thread flips items by message time, and an edit's new
// preview isn't in the event — so the caller refetches instead.
export function applyActivityChange(feed: ActivityFeed, change: ActivityChangedEvent): ActivityFeed | null {
  if (change.all) return markAllActivityRead(feed);
  if (change.ids && typeof change.read === 'boolean') return markActivityItems(feed, change.ids, change.read);
  if (change.removed) return removeActivityItems(feed, change.removed);
  return null;
}

// parseActivityNew reads the item out of an activity.new payload.
export function parseActivityNew(data: unknown): ActivityItem | null {
  const item = (data as { item?: Partial<ActivityItem> } | null)?.item;
  return item && typeof item.id === 'string' && typeof item.type === 'string' ? (item as ActivityItem) : null;
}

// parseActivityChange reads an activity.read payload; anything unreadable is an
// empty change, which the caller resolves by refetching.
export function parseActivityChange(data: unknown): ActivityChangedEvent {
  return data && typeof data === 'object' ? (data as ActivityChangedEvent) : {};
}

// ActivityRow is one row of the Activity page: a single item, or every item of
// one conversation (DM messages) or one thread (replies), newest first.
export interface ActivityRow {
  key: string;
  items: ActivityItem[];
  lead: ActivityItem;
  unreadIDs: string[];
}

// DM messages group per conversation and thread replies per thread, so a busy
// conversation is one row instead of one per message.
function rowKey(i: ActivityItem): string {
  if (i.type === 'dm') return `dm:${i.parentID}`;
  if (i.type === 'thread_reply') return `thread:${i.parentID}|${i.parentMessageID ?? ''}`;
  return `item:${i.id}`;
}

// groupActivity folds newest-first items into rows, each placed where its
// newest item sits.
export function groupActivity(items: ActivityItem[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const byKey = new Map<string, ActivityRow>();
  for (const item of items) {
    const key = rowKey(item);
    let row = byKey.get(key);
    if (!row) {
      row = { key, items: [], lead: item, unreadIDs: [] };
      byKey.set(key, row);
      rows.push(row);
    }
    row.items.push(item);
    if (!item.read) row.unreadIDs.push(item.id);
  }
  return rows;
}

export type ActivityTab = 'all' | 'mention' | 'thread_reply' | 'dm' | 'reaction';

export const ACTIVITY_TABS: { id: ActivityTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mention', label: 'Mentions' },
  { id: 'thread_reply', label: 'Threads' },
  { id: 'dm', label: 'DMs' },
  { id: 'reaction', label: 'Reactions' },
];

export function parseActivityTab(value: string | null): ActivityTab {
  return ACTIVITY_TABS.find((t) => t.id === value)?.id ?? 'all';
}

// Reminders and channel adds list under All only.
export function filterActivity(items: ActivityItem[], tab: ActivityTab): ActivityItem[] {
  return tab === 'all' ? items : items.filter((i) => i.type === tab);
}

export function tabHasUnread(feed: ActivityFeed, tab: ActivityTab): boolean {
  return (tab === 'all' ? feed.unread : (feed.unreadByType[tab] ?? 0)) > 0;
}
