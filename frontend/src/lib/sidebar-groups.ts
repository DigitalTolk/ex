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
}

const FAVORITES_KEY = '__favorites__';
const CHANNELS_DEFAULT_KEY = '__channels__';
const DMS_DEFAULT_KEY = '__dms__';

export const SidebarSectionKeys = {
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

  return sections;
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
