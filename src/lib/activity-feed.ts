import { calendarDaysAgo } from '@/lib/format';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';
import type { ActivityChangedEvent, ActivityFeed, ActivityItem, ActivityType, Reminder } from '@/types';

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

// isWebhookItem reports an item whose actor is an incoming webhook: its name
// is whatever the webhook chose, so it renders as a bot, never as a person.
// (Items written before the webhook flag existed carry only actorName.)
export function isWebhookItem(item: ActivityItem): boolean {
  return Boolean(item.webhook || item.actorName);
}

// ActivityRow is one row of the Activity list: a single item, or several that
// belong together — every message of one DM, the replies in one thread, the
// same emoji on one message — newest first. Acting on the row acts on all of
// its items.
export interface ActivityRow {
  key: string;
  items: ActivityItem[];
  // The newest item: its text, time and link represent the row.
  lead: ActivityItem;
  unreadIDs: string[];
  // The people who acted, newest first, each once (webhook posts excluded).
  actorIDs: string[];
}

function rowKey(i: ActivityItem): string {
  switch (i.type) {
    case 'dm':
      return `dm:${i.parentID}`;
    case 'thread_reply':
      return `thread:${i.parentID}|${i.parentMessageID || i.messageID}`;
    case 'reaction':
      return `reaction:${i.messageID}|${i.emoji ?? ''}`;
    default:
      return `item:${i.id}`;
  }
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
      row = { key, items: [], lead: item, unreadIDs: [], actorIDs: [] };
      byKey.set(key, row);
      rows.push(row);
    }
    row.items.push(item);
    if (!item.read) row.unreadIDs.push(item.id);
    if (item.actorID && !isWebhookItem(item) && !row.actorIDs.includes(item.actorID)) row.actorIDs.push(item.actorID);
  }
  return rows;
}

export type ActivityTab = 'all' | 'dm' | 'mention' | 'thread_reply' | 'reaction';

export const ACTIVITY_TABS: { id: ActivityTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'dm', label: 'DMs' },
  { id: 'mention', label: 'Mentions' },
  { id: 'thread_reply', label: 'Threads' },
  { id: 'reaction', label: 'Reactions' },
];

export function parseActivityTab(value: string | null): ActivityTab {
  return ACTIVITY_TABS.find((t) => t.id === value)?.id ?? 'all';
}

// Reminders and channel adds list under All only.
export function filterActivity(items: ActivityItem[], tab: ActivityTab): ActivityItem[] {
  return tab === 'all' ? items : items.filter((i) => i.type === tab);
}

export function tabUnread(feed: ActivityFeed, tab: ActivityTab): number {
  return tab === 'all' ? feed.unread : (feed.unreadByType[tab] ?? 0);
}

export type ActivityDay = 'Today' | 'Yesterday' | 'Earlier';

export function activityDay(createdAt: string, now: Date): ActivityDay {
  const days = calendarDaysAgo(createdAt, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return 'Earlier';
}

// activitySections splits rows into consecutive day groups, for the list's
// day headings.
export function activitySections(rows: ActivityRow[], now: Date = new Date()): { day: ActivityDay; rows: ActivityRow[] }[] {
  const sections: { day: ActivityDay; rows: ActivityRow[] }[] = [];
  for (const row of rows) {
    const day = activityDay(row.lead.createdAt, now);
    const last = sections[sections.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else sections.push({ day, rows: [row] });
  }
  return sections;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

// activityTime is a row's short time label, in the reader's locale: the clock
// time for today and yesterday (the day headings say which), the date before
// that.
export function activityTime(createdAt: string, now: Date = new Date()): string {
  const d = new Date(createdAt);
  return activityDay(createdAt, now) === 'Earlier' ? dateFormat.format(d) : timeFormat.format(d);
}

// activityHref links an activity row or a reminder to its message, opening its
// thread when it is a reply. A channel resolves by id first, so a renamed
// channel never falls back to a stale slug that may now name another channel.
export function activityHref(i: ActivityItem | Reminder, slugByChannelID: Map<string, string>): string {
  if (i.parentType !== 'channel') return buildConversationHref(i.parentID, i.messageID, i.parentMessageID);
  const slug = slugByChannelID.get(i.parentID) || i.channelSlug || i.parentID;
  return buildChannelHref(slug, i.messageID, i.parentMessageID);
}
