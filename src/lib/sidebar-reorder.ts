import type { SidebarItem } from '@/lib/sidebar-groups';

// Evenly-spaced position step. A drop DENSIFIES the whole target section to
// STEP, 2*STEP, 3*STEP… in the new visual order. This replaces the old sparse
// fractional scheme (`positionForDrop`) that produced negative/colliding
// positions and wedged once neighbor gaps collapsed — the "reorders don't
// stick" bug. Positions are always positive multiples of STEP, so they never
// collide with the "0 == unset" sentinel the render sort uses, and the order
// can never run out of gaps.
export const SIDEBAR_POSITION_STEP = 1000;

export type SidebarItemKind = 'channel' | 'conversation';

// One row's new sidebar state after a reorder. The mutation persists exactly
// these fields (category + favorite via the existing per-item endpoints, plus
// the dense position).
export interface SidebarReorderUpdate {
  id: string;
  kind: SidebarItemKind;
  categoryID: string;
  favorite: boolean;
  sidebarPosition: number;
}

// The (categoryID, favorite) a section imposes on the items it holds:
//   - Favorites: favorite = true, category unchanged (favorites keep their
//     category but display in the Favorites section).
//   - a user category: favorite = false, category = that category's id.
//   - the default Channels/DMs sections: favorite = false, category = "".
export interface SidebarSectionTarget {
  categoryID: string;
  favorite: boolean;
  // Favorites keeps each item's existing category, so the target can't supply
  // one value for all. When true, an item's categoryID is preserved.
  keepCategory?: boolean;
}

function itemID(item: SidebarItem): string {
  return item.kind === 'channel' ? item.channel.channelID : item.conversation.conversationID;
}

function itemState(item: SidebarItem): { categoryID: string; favorite: boolean; position: number } {
  const row = item.kind === 'channel' ? item.channel : item.conversation;
  return {
    categoryID: row.categoryID ?? '',
    favorite: !!row.favorite,
    // 0 and undefined both mean "unset" to the render sort; normalize to 0.
    position: row.sidebarPosition ?? 0,
  };
}

// computeSidebarReorder returns the persist-updates for dropping `draggedID`
// into `sectionItems` at `insertionIndex`. It DENSIFIES the section's new order
// to STEP multiples and returns only the rows whose (position | category |
// favorite) actually changed, so an in-place nudge writes the shifted tail and
// a cross-section move additionally rewrites the dragged row's category/favorite
// — never the whole app.
//
// `sectionItems` is the section's current render order (may or may not include
// the dragged item — a cross-section drop won't). `insertionIndex` is the
// edge-adjusted slot in the RENDERED list (including the still-present dragged
// row, as the drop payload reports it); this function removes the dragged item
// and maps the index onto the compacted order, so callers pass the raw payload
// index without pre-adjusting.
export function computeSidebarReorder(
  sectionItems: SidebarItem[],
  dragged: { id: string; kind: SidebarItemKind },
  insertionIndex: number,
  target: SidebarSectionTarget,
): SidebarReorderUpdate[] {
  const draggedID = dragged.id;
  const draggedKind = dragged.kind;

  // Where the dragged row currently sits in the rendered section (−1 if it's
  // coming from another section). When it's above the target slot, removing it
  // shifts every later index down by one — mirror that so the visual drop lands
  // where the user released.
  const currentIndex = sectionItems.findIndex((it) => itemID(it) === draggedID);
  const withoutDragged = sectionItems.filter((it) => itemID(it) !== draggedID);
  const rawIndex = currentIndex >= 0 && currentIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
  const clampedIndex = Math.max(0, Math.min(rawIndex, withoutDragged.length));

  // Preserve the dragged item's existing category when it's a channel and the
  // section keeps categories (Favorites); otherwise it adopts the section's.
  const draggedCurrentCategory =
    currentIndex >= 0 ? itemState(sectionItems[currentIndex]).categoryID : undefined;

  const newOrderIDs: Array<{ id: string; kind: SidebarItemKind }> = [
    ...withoutDragged.map((it) => ({ id: itemID(it), kind: it.kind })),
  ];
  newOrderIDs.splice(clampedIndex, 0, { id: draggedID, kind: draggedKind });

  const byID = new Map(sectionItems.map((it) => [itemID(it), it] as const));

  const updates: SidebarReorderUpdate[] = [];
  newOrderIDs.forEach((entry, i) => {
    const position = (i + 1) * SIDEBAR_POSITION_STEP;
    const isDragged = entry.id === draggedID;
    const existing = byID.get(entry.id);
    // A cross-section dragged row isn't yet in the section — give it a sentinel
    // NaN position so the change-detection below never matches it (it must always
    // be written). Every other row resolves to its real, normalized state.
    const current = existing ? itemState(existing) : { categoryID: '', favorite: false, position: NaN };

    // For the dragged row, `draggedCurrentCategory` already IS its own current
    // category (read from the same item) — undefined only on a cross-section
    // drag, where it correctly falls back to ''. Non-dragged rows keep the
    // category `itemState` already normalized to a string.
    const categoryID = target.keepCategory
      ? (isDragged ? (draggedCurrentCategory ?? '') : current.categoryID)
      : target.categoryID;
    const favorite = target.favorite;

    // Only write rows that actually change — a within-section nudge leaves the
    // untouched head alone, and unchanged non-dragged rows above the insertion
    // point keep their positions. (A cross-section dragged row's NaN position
    // never equals `position`, so it's always written.)
    if (
      current.position === position &&
      current.categoryID === categoryID &&
      current.favorite === favorite
    ) {
      return;
    }
    updates.push({ id: entry.id, kind: entry.kind, categoryID, favorite, sidebarPosition: position });
  });
  return updates;
}
