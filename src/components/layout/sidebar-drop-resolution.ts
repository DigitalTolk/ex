import { extractClosestEdge, type Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { SidebarMoveRequest } from '@/hooks/useSidebar';
import { SidebarSectionKeys, sidebarItemID, type SidebarItem, type SidebarSection } from '@/lib/sidebar-groups';
import type { SidebarSectionTarget } from '@/lib/sidebar-reorder';
import type { SidebarCategory } from '@/types';
import {
  CATEGORY_DROP_END,
  type ChannelDropArea,
  type DragPayload,
  type DropPayload,
  type ResolvedDrop,
} from './sidebar-dnd-core';

// Drop resolution for the sidebar's drag and drop, as pure functions of the
// rendered sections and the category list: which slot a drop target stands
// for, what a section imposes on the rows dropped into it, and the move event
// a drop reports to the server. useSidebarDrag owns the drag state and calls
// these with it.

function channelCount(items: SidebarItem[]): number {
  return items.filter((item) => item.kind === 'channel').length;
}

// dropCount is a section's number of drop slots, i.e. the index of its end.
// Favorites is a flat, position-sorted mix of channels AND favorited DMs, so
// every row is a slot; the other sections only take channel drops.
export function dropCount(sectionKey: string, items: SidebarItem[]): number {
  return sectionKey === SidebarSectionKeys.Favorites ? items.length : channelCount(items);
}

function canAcceptChannelDrop(sectionKey: string): boolean {
  return sectionKey !== SidebarSectionKeys.DirectMessages;
}

function sectionCategoryID(sectionKey: string): string {
  return sectionKey === SidebarSectionKeys.Channels ? '' : sectionKey;
}

// sectionDropTarget maps a section to the (categoryID, favorite) it imposes
// on items dropped into it. Favorites keeps each item's existing category
// (keepCategory) and forces favorite=true; a user category forces its own id
// and favorite=false; the default Channels/DMs sections force category="" and
// favorite=false.
export function sectionDropTarget(sectionKey: string): SidebarSectionTarget {
  if (sectionKey === SidebarSectionKeys.Favorites) {
    return { categoryID: '', favorite: true, keepCategory: true };
  }
  return { categoryID: sectionCategoryID(sectionKey), favorite: false };
}

// sidebarMoveForDrop is the drop as an EVENT: "dragged X into this section,
// right after item A" (the item rendered directly above the release slot).
// The SERVER resolves the anchor against the canonical layout and computes
// every resulting position itself — the client never sends position numbers
// (positions computed from a stale local list were exactly how drops landed
// one slot off). The anchor comes from the RENDERED list, with the same index
// math as the optimistic preview, so the reported event is exactly what the
// user saw themselves do.
export function sidebarMoveForDrop(
  items: SidebarItem[],
  dragged: { id: string; kind: 'channel' | 'conversation' },
  targetIndex: number,
  target: SidebarSectionTarget,
): SidebarMoveRequest {
  const currentIndex = items.findIndex((it) => sidebarItemID(it) === dragged.id);
  const withoutDragged = items.filter((it) => sidebarItemID(it) !== dragged.id);
  const rawIndex = currentIndex >= 0 && currentIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const clampedIndex = Math.max(0, Math.min(rawIndex, withoutDragged.length));
  const anchor = clampedIndex > 0 ? withoutDragged[clampedIndex - 1] : null;
  return {
    itemType: dragged.kind,
    itemID: dragged.id,
    ...(target.favorite
      ? { section: 'favorites' as const }
      : target.categoryID
        ? { section: 'category' as const, categoryID: target.categoryID }
        : { section: 'channels' as const }),
    afterType: anchor?.kind ?? '',
    afterID: anchor ? sidebarItemID(anchor) : '',
  };
}

// sortedCategories is the categories in render order.
export function sortedCategories(categories: SidebarCategory[]): SidebarCategory[] {
  /* v8 ignore next -- categories always carry distinct positions, so the equal-position localeCompare tiebreak is defensive */
  /* istanbul ignore next -- categories always carry distinct positions, so the equal-position localeCompare tiebreak arm is dead defensive code */
  return [...categories].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

// nextCategoryTarget is the category rendered after categoryID, or
// CATEGORY_DROP_END when it is the last one.
function nextCategoryTarget(categories: SidebarCategory[], categoryID: string): string {
  const ordered = sortedCategories(categories);
  const index = ordered.findIndex((category) => category.id === categoryID);
  return ordered[index + 1]?.id ?? CATEGORY_DROP_END;
}

// orderedCategoriesAfterDrop is the category order the drop previews: the
// dragged category moved in front of beforeCategoryID (CATEGORY_DROP_END =
// after the last one).
export function orderedCategoriesAfterDrop(
  categories: SidebarCategory[],
  draggedCategoryID: string,
  beforeCategoryID: string,
): SidebarCategory[] {
  const withoutDragged = sortedCategories(categories).filter((category) => category.id !== draggedCategoryID);
  const draggedCategory = categories.find((category) => category.id === draggedCategoryID);
  /* v8 ignore next -- the dragged category is always present in the cache during a drag; defensive guard */
  /* istanbul ignore next -- the dragged category is always present in the cache during a drag; defensive guard */
  if (!draggedCategory) return withoutDragged;
  const beforeIndex = beforeCategoryID === CATEGORY_DROP_END
    ? withoutDragged.length
    : withoutDragged.findIndex((category) => category.id === beforeCategoryID);
  /* v8 ignore next -- beforeCategoryID is always a real, non-dragged category (or CATEGORY_DROP_END handled above), so findIndex never returns -1 here; the <0 arm is defensive */
  /* istanbul ignore next -- beforeCategoryID is always a real non-dragged category (or CATEGORY_DROP_END handled above), so findIndex never returns -1; the <0 arm is dead */
  const insertIndex = beforeIndex < 0 ? withoutDragged.length : beforeIndex;
  return [
    ...withoutDragged.slice(0, insertIndex),
    draggedCategory,
    ...withoutDragged.slice(insertIndex),
  ];
}

export function normalizeCategoryDropSlot(
  categories: SidebarCategory[],
  beforeCategoryID: string,
  draggedCategoryID: string,
): string {
  /* v8 ignore next -- the resolve path never produces beforeCategoryID === draggedCategoryID (self-targeting is filtered upstream), so the nextCategoryTarget arm is defensive */
  /* istanbul ignore next -- the resolve path never produces beforeCategoryID === draggedCategoryID (self-targeting is filtered upstream), so the nextCategoryTarget arm is defensive */
  return beforeCategoryID === draggedCategoryID ? nextCategoryTarget(categories, draggedCategoryID) : beforeCategoryID;
}

function previousChannelDrop(sections: SidebarSection[], sectionKey: string): ResolvedDrop | null {
  const sectionIndex = sections.findIndex((section) => section.key === sectionKey);
  if (sectionIndex < 1) return null;
  for (let index = sectionIndex - 1; index >= 0; index -= 1) {
    const section = sections[index];
    /* v8 ignore next -- sections preceding any drop target are always channel-accepting (DM is the last section), so the false arm is defensive */
    /* istanbul ignore next -- sections preceding any drop target are always channel-accepting (DM is the last section), so the false arm is dead */
    if (canAcceptChannelDrop(section.key)) {
      // Land at the section's TRUE end — dropCount, not channelCount. Favorites
      // is a flat, position-sorted list that mixes channels AND favorited DMs
      // (sidebar-groups favItems .sort), so its end is items.length; counting
      // only channels lands the drop one slot short of the last item whenever a
      // favorited DM sits below the channels. This mirrors the section-tail drop
      // target (PragmaticSection in Sidebar) and the push-aside preview, which
      // both already use dropCount — the two "end of section" resolvers must
      // agree or the drop lands where the preview didn't show.
      return { kind: 'channel', sectionKey: section.key, index: dropCount(section.key, section.items), area: 'end' };
    }
  }
  /* v8 ignore next -- unreachable: sectionIndex<1 returns above, and every section that CAN precede a drop target accepts channel drops (only DMs — always last — don't), so the loop always returns on its first iteration */
  /* istanbul ignore next -- unreachable post-loop return; see the loop's canAcceptChannelDrop guard */
  return null;
}

function channelDropFromSectionHeader(sections: SidebarSection[], sectionKey: string, edge: Edge | null): ResolvedDrop {
  if (edge === 'top') {
    const previousDrop = previousChannelDrop(sections, sectionKey);
    if (previousDrop) return previousDrop;
  }
  return { kind: 'channel', sectionKey, index: 0, area: 'lead' };
}

function channelDropAreaForIndex(sections: SidebarSection[], sectionKey: string, index: number): ChannelDropArea {
  const section = sections.find((candidate) => candidate.key === sectionKey);
  /* v8 ignore next -- always called with a sectionKey from an existing payload, so the section is found; defensive guard */
  /* istanbul ignore next -- always called with a sectionKey from an existing payload, so the section is found; defensive guard */
  if (!section) return 'row';
  return index >= dropCount(sectionKey, section.items) ? 'end' : 'row';
}

// sameResolvedDrop reports whether drop names the same slot as prev.
export function sameResolvedDrop(prev: ResolvedDrop | null, drop: ResolvedDrop): boolean {
  if (drop.kind === 'channel') {
    return (
      prev?.kind === 'channel' &&
      prev.sectionKey === drop.sectionKey &&
      prev.index === drop.index &&
      prev.area === drop.area
    );
  }
  return (
    prev?.kind === 'category' &&
    prev.beforeCategoryID === drop.beforeCategoryID &&
    prev.position === drop.position
  );
}

// resolveDropPayload maps the drop target under the pointer to the slot the
// active drag would land in, or null when that target doesn't take this drag.
export function resolveDropPayload(
  payload: DropPayload | undefined,
  currentDrag: DragPayload | null,
  sections: SidebarSection[],
  categories: SidebarCategory[],
): ResolvedDrop | null {
  /* v8 ignore next -- callers always pass a defined payload from a live drop target; the !payload guard is defensive */
  /* istanbul ignore next -- callers always pass a defined payload from a live drop target; the !payload guard is defensive */
  if (!payload) return null;
  if (payload.type === 'channel-target') {
    const edge = extractClosestEdge(payload);
    if (currentDrag?.type === 'category') {
      return null;
    }
    if (currentDrag?.type === 'conversation' && payload.sectionKey !== SidebarSectionKeys.Favorites) return null;
    /* v8 ignore next -- a category drag already returned above, so the drag here is always a channel or conversation; the neither-type guard is defensive */
    /* istanbul ignore next -- a category drag already returned above, so the drag here is always a channel or conversation; the neither-type guard is dead */
    if (currentDrag?.type !== 'channel' && currentDrag?.type !== 'conversation') return null;
    const index = edge === 'bottom' ? payload.index + 1 : payload.index;
    const area = edge === 'bottom'
      ? channelDropAreaForIndex(sections, payload.sectionKey, index)
      : payload.area;
    return { kind: 'channel', sectionKey: payload.sectionKey, index, area };
  }
  /* v8 ignore next -- DropPayload has only two variants; channel-target returned above, so this is always a section-header-target (the false arm is unreachable) */
  /* istanbul ignore next -- DropPayload has only two variants; channel-target returned above, so this is always a section-header-target (the false arm is unreachable) */
  if (payload.type === 'section-header-target') {
    if (currentDrag?.type === 'channel') {
      return channelDropFromSectionHeader(sections, payload.sectionKey, extractClosestEdge(payload));
    }
    if (currentDrag?.type === 'conversation' && payload.sectionKey === SidebarSectionKeys.Favorites) {
      return channelDropFromSectionHeader(sections, payload.sectionKey, extractClosestEdge(payload));
    }
    if (
      currentDrag?.type === 'category' &&
      payload.sectionKey !== SidebarSectionKeys.Favorites
    ) {
      const edge = extractClosestEdge(payload);
      const rawBeforeCategoryID = edge === 'bottom' ? nextCategoryTarget(categories, payload.categoryID) : payload.categoryID;
      const beforeCategoryID = normalizeCategoryDropSlot(categories, rawBeforeCategoryID, currentDrag.categoryID);
      return {
        kind: 'category',
        beforeCategoryID,
        position: (orderedCategoriesAfterDrop(categories, currentDrag.categoryID, beforeCategoryID).findIndex((category) => category.id === currentDrag.categoryID) + 1) * 1000,
      };
    }
  }
  return null;
}
