import type { UserChannel, UserConversation, SidebarCategory } from '@/types';

// SidebarItem is the discriminated union the sidebar renders. A user's
// favorites and category sections can hold a mix of channels and DMs,
// so a single list type lets the renderer treat them uniformly.
export type SidebarItem =
  | { kind: 'channel'; channel: UserChannel }
  | { kind: 'conversation'; conversation: UserConversation };

export interface SidebarSection {
  key: string;
  title: string;
  items: SidebarItem[];
  category?: SidebarCategory;
}

export type ConversationSidebarSort = 'recent' | 'az';

export interface SidebarGroupOptions {
  conversationSort?: ConversationSidebarSort;
  // Pull every unread channel/DM into an "Unread" section at the top
  // (Mattermost's "group unread separately"), out of its usual section.
  unreadSection?: boolean;
  // Show only unread channels/DMs, in their usual sections.
  unreadOnly?: boolean;
  // The chat being viewed: never filtered out by unreadOnly, so opening it
  // (which reads it) doesn't make its row vanish.
  activeID?: string;
  // Kept in the Unread section although now read — the chat being viewed,
  // if it was unread when opened, until the user leaves it.
  stickyUnreadID?: string;
}

const UNREAD_KEY = '__unread__';
const FAVORITES_KEY = '__favorites__';
const CHANNELS_DEFAULT_KEY = '__channels__';
const DMS_DEFAULT_KEY = '__dms__';

export const SidebarSectionKeys = {
  Unread: UNREAD_KEY,
  Favorites: FAVORITES_KEY,
  Channels: CHANNELS_DEFAULT_KEY,
  DirectMessages: DMS_DEFAULT_KEY,
} as const;

// groupSidebarItems lays out the sidebar top-to-bottom:
//   - Favorites: every favorited channel + DM mixed.
//   - User-defined categories (in position order): channels and DMs
//     assigned to that category, mixed.
//   - "Channels": uncategorised, unfavorited channels.
//   - "Direct Messages": uncategorised, unfavorited DMs/groups.
//
// A favorited item appears ONLY in Favorites — never duplicated under
// its category. Stale categoryIDs (deleted category) fall through to
// the appropriate default section, which the delete flow relies on.
export function groupSidebarItems(
  channels: UserChannel[],
  conversations: UserConversation[],
  categories: SidebarCategory[],
  options: SidebarGroupOptions = {},
): SidebarSection[] {
  const sections: SidebarSection[] = [];
  const conversationSort = options.conversationSort ?? 'recent';
  const sortedChannels = [...channels].sort(compareChannels);
  const sortedConversations = [...conversations].sort((a, b) =>
    compareConversations(a, b, conversationSort),
  );

  const favItems: SidebarItem[] = [
    ...sortedChannels.filter((c) => c.favorite).map((c): SidebarItem => ({ kind: 'channel', channel: c })),
    ...sortedConversations.filter((c) => c.favorite).map((c): SidebarItem => ({ kind: 'conversation', conversation: c })),
  ].sort(compareSidebarItems);
  sections.push({ key: FAVORITES_KEY, title: 'Favorites', items: favItems });

  const sortedCats = [...categories].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id.localeCompare(b.id);
  });
  const knownCategoryIDs = new Set(categories.map((c) => c.id));
  for (const cat of sortedCats) {
    const items: SidebarItem[] = [
      ...sortedChannels
        .filter((c) => !c.favorite && c.categoryID === cat.id)
        .map((c): SidebarItem => ({ kind: 'channel', channel: c })),
      ...sortedConversations
        .filter((c) => !c.favorite && c.categoryID === cat.id)
        .map((c): SidebarItem => ({ kind: 'conversation', conversation: c })),
    ];
    sections.push({ key: cat.id, title: cat.name, category: cat, items });
  }

  // Default Channels: unfavorited and either uncategorised or pointing at
  // a deleted category.
  const channelsDefault = sortedChannels
    .filter((c) => !c.favorite && (!c.categoryID || !knownCategoryIDs.has(c.categoryID)))
    .map((c): SidebarItem => ({ kind: 'channel', channel: c }));
  sections.push({ key: CHANNELS_DEFAULT_KEY, title: 'Channels', items: channelsDefault });

  const dmsDefault = sortedConversations
    .filter((c) => !c.favorite && (!c.categoryID || !knownCategoryIDs.has(c.categoryID)))
    .map((c): SidebarItem => ({ kind: 'conversation', conversation: c }));
  sections.push({ key: DMS_DEFAULT_KEY, title: 'Direct Messages', items: dmsDefault });

  return applyUnreadView(sections, options);
}

// applyUnreadView layers the unread options over the grouped sections. The
// Unread section keeps sidebar order (favorites, categories, channels, DMs).
function applyUnreadView(sections: SidebarSection[], options: SidebarGroupOptions): SidebarSection[] {
  const { unreadSection, unreadOnly, activeID, stickyUnreadID } = options;
  if (!unreadSection && !unreadOnly) return sections;
  const inUnread = (item: SidebarItem) => isSidebarItemUnread(item) || sidebarItemID(item) === stickyUnreadID;
  let out = sections;
  if (unreadSection) {
    const unread = out.flatMap((section) => section.items.filter(inUnread));
    out = [
      { key: UNREAD_KEY, title: 'Unread', items: unread },
      ...out.map((section) => ({ ...section, items: section.items.filter((item) => !inUnread(item)) })),
    ];
  }
  if (unreadOnly) {
    out = out.map((section) => ({
      ...section,
      items: section.items.filter((item) => inUnread(item) || sidebarItemID(item) === activeID),
    }));
  }
  return out;
}

// isSidebarItemUnread is what the Unread section and filter count as unread:
// what the row's bold/dot/badge shows — except a muted channel, which only
// counts once something actually alerted (a mention), like Mattermost.
export function isSidebarItemUnread(item: SidebarItem): boolean {
  if (item.kind === 'channel') {
    const c = item.channel;
    return (c.unreadNotifyCount ?? 0) > 0 || (!c.muted && !!c.unread);
  }
  return !!item.conversation.unread || (item.conversation.unreadNotifyCount ?? 0) > 0;
}

export function sidebarItemID(item: SidebarItem): string {
  return item.kind === 'channel' ? item.channel.channelID : item.conversation.conversationID;
}

function compareSidebarItems(a: SidebarItem, b: SidebarItem): number {
  const pos = compareSparsePosition(itemPosition(a), itemPosition(b));
  if (pos !== 0) return pos;
  return itemLabel(a).localeCompare(itemLabel(b), undefined, { sensitivity: 'base' });
}

function itemPosition(item: SidebarItem): number | undefined {
  return item.kind === 'channel'
    ? item.channel.sidebarPosition
    : item.conversation.sidebarPosition;
}

function itemLabel(item: SidebarItem): string {
  return item.kind === 'channel'
    ? item.channel.channelName
    : item.conversation.displayName;
}

function compareChannels(a: UserChannel, b: UserChannel): number {
  const pos = compareSparsePosition(a.sidebarPosition, b.sidebarPosition);
  if (pos !== 0) return pos;
  return a.channelName.localeCompare(b.channelName, undefined, { sensitivity: 'base' });
}

function compareConversations(
  a: UserConversation,
  b: UserConversation,
  sort: ConversationSidebarSort,
): number {
  if (sort === 'az') {
    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  }
  const aTime = Date.parse(a.updatedAt ?? '');
  const bTime = Date.parse(b.updatedAt ?? '');
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return bTime - aTime;
  }
  if (Number.isFinite(aTime) !== Number.isFinite(bTime)) {
    /* istanbul ignore next -- both arms are exercised by the "both orderings" test (reversed inputs), but with a 2-element array the sort engine only invokes the comparator in one argument order per run, so the merge cannot attribute both the `1` and `-1` arms to a single line; the behaviour is covered. */
    return Number.isFinite(bTime) ? 1 : -1;
  }
  return 0;
}

function compareSparsePosition(a?: number, b?: number): number {
  const aSet = Number.isFinite(a) && a !== 0;
  const bSet = Number.isFinite(b) && b !== 0;
  if (aSet && bSet && a !== b) return (a as number) - (b as number);
  if (aSet !== bSet) return aSet ? -1 : 1;
  return 0;
}
