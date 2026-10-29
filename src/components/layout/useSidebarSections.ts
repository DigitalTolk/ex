import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useUnread } from '@/context/UnreadContext';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useCategories } from '@/hooks/useSidebar';
import { useUserState } from '@/hooks/useUserState';
import { slugify } from '@/lib/format';
import {
  archivedSidebarChannels,
  groupSidebarItems,
  isSidebarItemUnread,
  SidebarSectionKeys,
  type ChannelSidebarSort,
  type ConversationSidebarSort,
  type SidebarItem,
  type SidebarSection,
} from '@/lib/sidebar-groups';
import type { SidebarCategory } from '@/types';

const NO_CATEGORIES: SidebarCategory[] = [];

// useSidebarSections loads what the sidebar lists and lays it out in sections
// (see groupSidebarItems) under the user's view preferences.
export function useSidebarSections({
  conversationSort,
  channelSort,
  unreadSection,
  unreadOnly,
}: {
  conversationSort: ConversationSidebarSort;
  channelSort: ChannelSidebarSort;
  unreadSection: boolean;
  unreadOnly: boolean;
}) {
  const { hiddenConversations } = useUnread();
  const { data: channels } = useUserChannels();
  const conversationsQuery = useUserConversations();
  const { data: conversations } = conversationsQuery;
  const { data: userState } = useUserState();
  const { data: categories = NO_CATEGORIES } = useCategories();
  const { pathname } = useLocation();

  const visibleConversations = useMemo(
    () => {
      const hidden = new Set([...(userState?.hiddenConversations ?? []), ...hiddenConversations]);
      return conversations?.filter((c) => !hidden.has(c.conversationID)) ?? [];
    },
    [conversations, hiddenConversations, userState?.hiddenConversations],
  );

  // The chat being viewed. With the unread view on it stays visible even
  // though opening it reads it, and — if it was unread when opened — stays in
  // the Unread section until the user leaves, so rows don't jump mid-read.
  const activeItemID = useMemo(() => {
    const ch = channels?.find((c) => pathname === `/channel/${slugify(c.channelName)}` || pathname === `/channel/${c.channelID}`);
    if (ch) return ch.channelID;
    return /^\/conversation\/([^/]+)/.exec(pathname)?.[1];
  }, [pathname, channels]);
  const activeItemUnread = useMemo(() => {
    const ch = channels?.find((c) => c.channelID === activeItemID);
    if (ch) return isSidebarItemUnread({ kind: 'channel', channel: ch });
    const conv = visibleConversations.find((c) => c.conversationID === activeItemID);
    return !!conv && isSidebarItemUnread({ kind: 'conversation', conversation: conv });
  }, [channels, visibleConversations, activeItemID]);
  const [stickyUnread, setStickyUnread] = useState<{ id?: string; unread: boolean }>({ unread: false });
  if (stickyUnread.id !== activeItemID) setStickyUnread({ id: activeItemID, unread: activeItemUnread });

  const sections = useMemo(
    () =>
      groupSidebarItems(channels ?? [], visibleConversations, categories, {
        conversationSort,
        channelSort,
        unreadSection,
        unreadOnly,
        activeID: activeItemID,
        stickyUnreadID: stickyUnread.unread ? stickyUnread.id : undefined,
      }),
    [channels, visibleConversations, categories, conversationSort, channelSort, unreadSection, unreadOnly, activeItemID, stickyUnread],
  );

  const archivedChannels = useMemo(() => archivedSidebarChannels(channels ?? []), [channels]);

  return {
    // The sections render once the DMs are in (or failed to load); until then
    // the sidebar shows a skeleton.
    ready: conversations !== undefined || conversationsQuery.isError,
    sections,
    archivedChannels,
    visibleConversations,
    categories,
  };
}

// isSectionHidden: the unread view hides what has nothing to show — an empty
// Unread section always, and any empty section while filtering.
export function isSectionHidden(section: SidebarSection, unreadOnly: boolean): boolean {
  return section.items.length === 0 && (section.key === SidebarSectionKeys.Unread || unreadOnly);
}

// spacedSectionKeys is which section headings get the wide gap above them: an
// open section's, and the one after an open section. Collapsed headings in a
// row pack tight. Hidden sections (as the list skips them) don't count.
export function spacedSectionKeys(
  sections: SidebarSection[],
  collapsed: Record<string, boolean>,
  unreadOnly: boolean,
): Set<string> {
  const spaced = new Set<string>();
  let prevOpen = false;
  for (const section of sections) {
    if (isSectionHidden(section, unreadOnly)) continue;
    const open = !collapsed[section.key];
    if (open || prevOpen) spaced.add(section.key);
    prevOpen = open;
  }
  return spaced;
}

// foldedSectionItems is what a collapsed section still shows:
//   - items with new activity (unless muted) so the user doesn't miss
//     messages hidden behind a folded category;
//   - the channel/conversation the user is currently viewing, so navigating
//     away from it (or scrolling up) doesn't make the row vanish out from
//     under them. Once they switch focus elsewhere, the row hides again on
//     the next render.
export function foldedSectionItems(items: SidebarItem[], pathname: string): SidebarItem[] {
  return items.filter((item) => {
    if (item.kind === 'channel') {
      const ch = item.channel;
      const isActive = pathname === `/channel/${slugify(ch.channelName)}`;
      return isActive || (!ch.muted && !!ch.unread);
    }
    const conv = item.conversation;
    const isActive = pathname === `/conversation/${conv.conversationID}`;
    return isActive || !!conv.unread;
  });
}
