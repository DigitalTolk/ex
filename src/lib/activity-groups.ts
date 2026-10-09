import type { ActivityFeed, ActivityItem, ActivityType } from '@/types';

// The Activity tab's filters. "All" lists everything; each other tab lists
// the item types it names. Reminders and channel adds only appear under All.
export type ActivityFilter = 'all' | 'dms' | 'mentions' | 'threads' | 'reactions';

export const ACTIVITY_FILTERS: { key: ActivityFilter; label: string; types: ActivityType[] | null }[] = [
  { key: 'all', label: 'All', types: null },
  { key: 'dms', label: 'DMs', types: ['dm'] },
  { key: 'mentions', label: 'Mentions', types: ['mention'] },
  { key: 'threads', label: 'Threads', types: ['thread_reply'] },
  { key: 'reactions', label: 'Reactions', types: ['reaction'] },
];

function filterTypes(filter: ActivityFilter): ActivityType[] | null {
  return ACTIVITY_FILTERS.find((f) => f.key === filter)!.types;
}

export function matchesFilter(type: ActivityType, filter: ActivityFilter): boolean {
  const types = filterTypes(filter);
  return types === null || types.includes(type);
}

// unreadForFilter is how many unread items a tab holds, from the feed's
// per-type counts. Drives the dot next to each tab label.
export function unreadForFilter(feed: Pick<ActivityFeed, 'unread' | 'unreadByType'>, filter: ActivityFilter): number {
  const types = filterTypes(filter);
  if (types === null) return feed.unread;
  return types.reduce((n, t) => n + (feed.unreadByType?.[t] ?? 0), 0);
}

// One row in the list. Several items can share a row: replies in the same
// thread ("Kirill and 2 others replied"), reactions with the same emoji on the
// same message, and messages in the same DM. The row acts on all its ids.
export interface ActivityRow {
  key: string;
  ids: string[];
  // Newest item in the row; its text, time and link represent the row.
  latest: ActivityItem;
  // Distinct actors, newest first.
  actorIDs: string[];
  unread: boolean;
  count: number;
}

function groupKey(item: ActivityItem): string {
  switch (item.type) {
    case 'thread_reply':
      return `thread:${item.parentID}:${item.parentMessageID || item.messageID}`;
    case 'reaction':
      return `reaction:${item.messageID}:${item.emoji ?? ''}`;
    case 'dm':
      return `dm:${item.parentID}`;
    default:
      return `item:${item.id}`;
  }
}

// groupActivity folds a newest-first item list into rows, each positioned
// where its newest item was. Grouping keeps unread and read items together:
// opening the row reads all of it.
export function groupActivity(items: ActivityItem[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const byKey = new Map<string, ActivityRow>();
  for (const item of items) {
    const key = groupKey(item);
    const row = byKey.get(key);
    if (!row) {
      const fresh: ActivityRow = {
        key,
        ids: [item.id],
        latest: item,
        actorIDs: item.actorID ? [item.actorID] : [],
        unread: !item.read,
        count: 1,
      };
      byKey.set(key, fresh);
      rows.push(fresh);
      continue;
    }
    row.ids.push(item.id);
    row.count += 1;
    row.unread = row.unread || !item.read;
    if (item.actorID && !row.actorIDs.includes(item.actorID)) row.actorIDs.push(item.actorID);
  }
  return rows;
}

export type ActivityDay = 'Today' | 'Yesterday' | 'Earlier';

export function activityDay(createdAt: string, now: Date = new Date()): ActivityDay {
  const d = new Date(createdAt);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return 'Earlier';
}

// withRead returns the feed with the given items marked read (or unread) and
// its unread counts recomputed — the optimistic update for the per-item
// read endpoints.
export function withRead(feed: ActivityFeed, ids: string[], read: boolean): ActivityFeed {
  const set = new Set(ids);
  return recount({ ...feed, items: feed.items.map((i) => (set.has(i.id) ? { ...i, read } : i)) });
}

// withoutItems returns the feed with the given items removed.
export function withoutItems(feed: ActivityFeed, ids: string[]): ActivityFeed {
  const set = new Set(ids);
  return recount({ ...feed, items: feed.items.filter((i) => !set.has(i.id)) });
}

function recount(feed: ActivityFeed): ActivityFeed {
  const unreadByType: Partial<Record<ActivityType, number>> = {};
  let unread = 0;
  for (const i of feed.items) {
    if (i.read) continue;
    unread += 1;
    unreadByType[i.type] = (unreadByType[i.type] ?? 0) + 1;
  }
  return { ...feed, unread, unreadByType };
}

// activityTime is the short time label on a row: the clock time for today
// and yesterday (the list's day headings say which), the date before that.
export function activityTime(createdAt: string, now: Date = new Date()): string {
  const d = new Date(createdAt);
  if (activityDay(createdAt, now) === 'Earlier') {
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
