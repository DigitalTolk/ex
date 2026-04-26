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
): SidebarSection[] {
  const sections: SidebarSection[] = [];

  const favItems: SidebarItem[] = [
    ...channels.filter((c) => c.favorite).map((c): SidebarItem => ({ kind: 'channel', channel: c })),
    ...conversations.filter((c) => c.favorite).map((c): SidebarItem => ({ kind: 'conversation', conversation: c })),
  ];
  sections.push({ key: FAVORITES_KEY, title: 'Favorites', items: favItems });

  const sortedCats = [...categories].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position;
    return a.id.localeCompare(b.id);
  });
  const knownCategoryIDs = new Set(categories.map((c) => c.id));
  for (const cat of sortedCats) {
    const items: SidebarItem[] = [
      ...channels
        .filter((c) => !c.favorite && c.categoryID === cat.id)
        .map((c): SidebarItem => ({ kind: 'channel', channel: c })),
      ...conversations
        .filter((c) => !c.favorite && c.categoryID === cat.id)
        .map((c): SidebarItem => ({ kind: 'conversation', conversation: c })),
    ];
    sections.push({ key: cat.id, title: cat.name, category: cat, items });
  }

  // Default Channels: unfavorited and either uncategorised or pointing at
  // a deleted category.
  const channelsDefault = channels
    .filter((c) => !c.favorite && (!c.categoryID || !knownCategoryIDs.has(c.categoryID)))
    .map((c): SidebarItem => ({ kind: 'channel', channel: c }));
  sections.push({ key: CHANNELS_DEFAULT_KEY, title: 'Channels', items: channelsDefault });

  const dmsDefault = conversations
    .filter((c) => !c.favorite && (!c.categoryID || !knownCategoryIDs.has(c.categoryID)))
    .map((c): SidebarItem => ({ kind: 'conversation', conversation: c }));
  sections.push({ key: DMS_DEFAULT_KEY, title: 'Direct Messages', items: dmsDefault });

  return sections;
}
