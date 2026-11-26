import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { useReorderCategories, useReorderSidebar } from '@/hooks/useSidebar';
import { SidebarSectionKeys, type SidebarItem, type SidebarSection } from '@/lib/sidebar-groups';
import { computeSidebarReorder, type SidebarSectionTarget } from '@/lib/sidebar-reorder';
import type { SidebarCategory } from '@/types';
import type { DragPayload, DropIndicator, DropPayload, ResolvedDrop } from './sidebar-dnd-core';
import {
  normalizeCategoryDropSlot,
  orderedCategoriesAfterDrop,
  resolveDropPayload,
  sameResolvedDrop,
  sectionDropTarget,
  sidebarMoveForDrop,
} from './sidebar-drop-resolution';
import { useSidebarDndTrace } from './useSidebarDndTrace';

function currentDropPayload(location: { dropTargets: Array<{ data: Record<string | symbol, unknown> }> }): DropPayload | undefined {
  return location.dropTargets[0]?.data as DropPayload | undefined;
}

// useNavigationSuppression: the click that ends a drag lands on the row it
// started from, and must not navigate there. A drag start suppresses that
// row's navigation; the row consumes the suppression (or it lapses 750ms
// after the drop).
function useNavigationSuppression() {
  const [suppressedID, setSuppressedID] = useState<string | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  // Stable, like every callback the rows get: the rows are memoized, so a
  // navigation (which re-renders the list) re-renders only the rows whose
  // own data changed.
  const clear = useCallback(() => {
    /* v8 ignore next -- the consumed callback fires right after a drop scheduled the reset timeout, so the ref is set; the null arm is defensive */
    /* istanbul ignore next -- the consumed callback fires right after a drop scheduled the reset timeout, so the ref is set; the null arm is defensive */
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setSuppressedID(null);
  }, []);

  // A drop schedules the 750ms reset below; clear it on unmount so the timer
  // never fires into a torn-down tree (it crashed test teardown with "window
  // is not defined" when a suite ended within 750ms of a drop).
  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  function suppress(id: string | null) {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setSuppressedID(id);
  }

  function releaseSoon() {
    // Reuses clear as the callback (clearTimeout on the already-fired id is a
    // no-op) instead of a dedicated closure: the unmount cleanup above can
    // cancel this timer before it ever fires in a test run, and a function
    // literal that only executes when the suite happens to outlast 750ms is a
    // coverage coin-flip (bit CI 2026-07-14).
    resetTimerRef.current = window.setTimeout(clear, 750);
  }

  return { suppressedID, suppress, releaseSoon, clear };
}

// useSidebarDrag runs the sidebar's drag and drop: it follows every drag
// through the Pragmatic monitor, keeps the live drop indicator (which also
// drives the push-aside preview), and on drop reports the move — a channel or
// DM into a section, or a category into the category order — to the server.
//
// sections and categories are the ones rendered: a drop resolves against
// exactly what the user saw. onOrderChosen runs with a section's key when a
// row is dragged to a new slot within that section — the user picked an order
// by hand, so a "Recent activity" sort gives way to it.
export function useSidebarDrag(
  sections: SidebarSection[],
  categories: SidebarCategory[],
  onOrderChosen?: (sectionKey: string) => void,
) {
  const reorderSidebar = useReorderSidebar();
  const reorderCategories = useReorderCategories();
  const activeDragRef = useRef<DragPayload | null>(null);
  const [isDraggingCategory, setIsDraggingCategory] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const visibleDropIndicatorRef = useRef<DropIndicator | null>(null);
  const resolvedDropRef = useRef<ResolvedDrop | null>(null);
  const navigation = useNavigationSuppression();
  const trace = useSidebarDndTrace({ sections, categories, activeDragRef, resolvedDropRef });

  function resolve(payload: DropPayload | undefined): ResolvedDrop | null {
    return resolveDropPayload(payload, activeDragRef.current, sections, categories);
  }

  function showDropIndicator(drop: ResolvedDrop) {
    resolvedDropRef.current = drop;
    // An unchanged slot keeps the previous indicator, so a pointer resting on
    // one slot doesn't re-render the list on every drag event.
    setDropIndicator((prev) => (sameResolvedDrop(prev, drop) ? prev : drop));
  }

  function clearDropTarget() {
    resolvedDropRef.current = null;
    setDropIndicator(null);
  }

  // persistReorder reports a channel/DM drop as a move event (see
  // sidebarMoveForDrop). computeSidebarReorder still runs, but only to paint
  // the optimistic preview; the server's response replaces it as the truth.
  function persistReorder(
    items: SidebarItem[],
    dragged: { id: string; kind: 'channel' | 'conversation' },
    targetIndex: number,
    target: SidebarSectionTarget,
  ) {
    const updates = computeSidebarReorder(items, dragged, targetIndex, target);
    /* v8 ignore next 4 -- a no-op drop (section already densely ordered and the item released at its own slot) yields zero updates; that empty-result path is unit-tested directly in sidebar-reorder.test.ts, but the mocked-mutation drag harness can't re-densify the cache to reproduce it here */
    /* istanbul ignore next -- empty-updates no-op path; covered by sidebar-reorder.test.ts, unreachable via the mocked-mutation drag harness */
    if (updates.length === 0) {
      clearDropTarget();
      return;
    }
    const move = sidebarMoveForDrop(items, dragged, targetIndex, target);
    trace.logChannel('reorder scheduled', {
      draggedID: dragged.id,
      move,
      updates,
      order: trace.channelOrder(),
    });
    reorderSidebar.mutate({ move, updates });
    clearDropTarget();
  }

  function moveCategoryBefore(draggedCategoryID: string, beforeCategoryID: string) {
    const normalizedBeforeCategoryID = normalizeCategoryDropSlot(categories, beforeCategoryID, draggedCategoryID);
    const draggedCategory = categories.find((category) => category.id === draggedCategoryID);
    /* v8 ignore start -- the dragged category is always in the cache during a drag; defensive guard */
    /* istanbul ignore next -- the dragged category is always in the cache during a drag; this guard is dead defensive code */
    if (!draggedCategory) {
      trace.logCategory('category-drop ignored: dragged category missing from cache', {
        draggedCategoryID,
        beforeCategoryID: normalizedBeforeCategoryID,
        order: trace.categoryOrder(),
      });
      return;
    }
    /* v8 ignore stop */

    const nextOrder = orderedCategoriesAfterDrop(categories, draggedCategoryID, normalizedBeforeCategoryID);
    // The event the server needs: which category the dragged one lands AFTER
    // in the order the user just previewed ("" = the very top). The server
    // renumbers everything itself; nextOrder only paints the optimistic state.
    const draggedIndex = nextOrder.findIndex((category) => category.id === draggedCategoryID);
    const afterID = draggedIndex > 0 ? nextOrder[draggedIndex - 1].id : '';
    trace.logCategory('category-reorder scheduled', {
      draggedCategoryID,
      beforeCategoryID: normalizedBeforeCategoryID,
      afterID,
      order: nextOrder.map((category) => category.id),
      previousOrder: trace.categoryOrder(),
    });
    reorderCategories.mutate({ categories: nextOrder, movedID: draggedCategoryID, afterID });
    setDropIndicator(null);
  }

  function applyResolvedDrop(drop: ResolvedDrop | null) {
    if (!drop) return;
    const drag = activeDragRef.current;
    if (drop.kind === 'channel') {
      const section = sections.find((candidate) => candidate.key === drop.sectionKey);
      /* v8 ignore next -- the drop was resolved from an existing section, so it is always found; defensive guard */
      /* istanbul ignore next -- the drop was resolved from an existing section, so it is always found; defensive guard */
      if (!section) return;
      if (drag?.type === 'channel') {
        /* v8 ignore next -- a resolved channel drop never targets the DM section (resolveDropPayload only yields channel-accepting sections); defensive guard */
        /* istanbul ignore next -- a resolved channel drop never targets the DM section (resolveDropPayload only yields channel-accepting sections); this guard is dead defensive code */
        if (drop.sectionKey === SidebarSectionKeys.DirectMessages) return;
        const draggedID = drag.channel.channelID;
        if (section.items.some((item) => item.kind === 'channel' && item.channel.channelID === draggedID)) {
          onOrderChosen?.(drop.sectionKey);
        }
        persistReorder(section.items, { id: draggedID, kind: 'channel' }, drop.index, sectionDropTarget(drop.sectionKey));
        return;
      }
      /* v8 ignore start -- a channel-kind drop only originates from a channel or conversation drag, and a conversation drag only resolves onto Favorites; after the channel branch returns, both guards are defensive */
      /* istanbul ignore next -- after the channel branch returns, a channel-kind drop's active drag is always a conversation, so the false arm is dead */
      if (drag?.type !== 'conversation') return;
      /* istanbul ignore next -- a conversation drag only resolves onto Favorites; the non-Favorites guard is dead defensive code */
      if (drop.sectionKey !== SidebarSectionKeys.Favorites) return;
      /* v8 ignore stop */
      // Only a favorite is a conversation drag source, so this is always a
      // new slot within Favorites.
      onOrderChosen?.(drop.sectionKey);
      persistReorder(
        section.items,
        { id: drag.conversation.conversationID, kind: 'conversation' },
        drop.index,
        sectionDropTarget(drop.sectionKey),
      );
      return;
    }
    /* v8 ignore next -- a category-kind drop only originates from a category drag; the early-return arm is dead */
    /* istanbul ignore next -- a category-kind drop only originates from a category drag; the early-return arm is dead */
    if (drag?.type !== 'category') return;
    moveCategoryBefore(drag.categoryID, drop.beforeCategoryID);
  }

  function handleDragStart(payload: DragPayload | null) {
    activeDragRef.current = payload;
    flushSync(() => {
      setIsDraggingCategory(payload?.type === 'category');
    });
    trace.dragStart(payload);
    navigation.suppress(
      payload?.type === 'channel'
        ? payload.channel.channelID
        : payload?.type === 'conversation'
          ? payload.conversation.conversationID
          : null,
    );
    clearDropTarget();
  }

  function updateResolvedDrop(payload: DropPayload | undefined) {
    const resolvedDrop = resolve(payload);
    const previousChannelDrop = activeDragRef.current?.type === 'channel' && resolvedDropRef.current?.kind === 'channel'
      ? resolvedDropRef.current
      : null;
    const effectiveChannelDrop = resolvedDrop ?? previousChannelDrop;
    trace.targetResolved(payload, resolvedDrop, effectiveChannelDrop);
    if (!resolvedDrop) {
      if (
        activeDragRef.current?.type === 'category' &&
        resolvedDropRef.current?.kind === 'category'
      ) {
        return;
      }
      if (
        activeDragRef.current?.type === 'channel' &&
        resolvedDropRef.current?.kind === 'channel'
      ) {
        return;
      }
      clearDropTarget();
      return;
    }
    showDropIndicator(resolvedDrop);
  }

  function handleDrop(payload: DropPayload | undefined) {
    // Prefer resolvedDropRef — it's written SYNCHRONOUSLY the moment an indicator
    // resolves (showDropIndicator), so it's always the latest slot. The
    // visibleDropIndicatorRef mirror is synced by a useLayoutEffect and therefore
    // LAGS by a commit; releasing right after the final move (e.g. dragging out
    // of the preview's range and letting go before React commits) read that stale
    // ref and dropped one slot too high, not where the preview showed. Fall back
    // to the mirror, then to a fresh resolve of the raw drop payload.
    const resolvedDrop = activeDragRef.current
      ? (resolvedDropRef.current ?? visibleDropIndicatorRef.current ?? resolve(payload))
      : resolve(payload);
    trace.dropReceived(payload, resolvedDrop);
    applyResolvedDrop(resolvedDrop);
    activeDragRef.current = null;
    setIsDraggingCategory(false);
    trace.dragEnd();
    clearDropTarget();
    navigation.releaseSoon();
  }

  // The monitor is registered once; it calls the latest render's handlers
  // (they close over that render's sections and categories).
  const handlersRef = useRef({ handleDragStart, updateResolvedDrop, handleDrop, monitorEvent: trace.monitorEvent });

  useLayoutEffect(() => {
    visibleDropIndicatorRef.current = dropIndicator;
  }, [dropIndicator]);

  useLayoutEffect(() => {
    handlersRef.current = { handleDragStart, updateResolvedDrop, handleDrop, monitorEvent: trace.monitorEvent };
  });

  useEffect(() => {
    return monitorForElements({
      onDragStart: ({ source }) => {
        handlersRef.current.handleDragStart(source.data as DragPayload);
      },
      onDropTargetChange: ({ location }) => {
        const payload = currentDropPayload(location.current);
        handlersRef.current.monitorEvent('dropTargetChange', payload);
        handlersRef.current.updateResolvedDrop(payload);
      },
      onDrag: ({ location }) => {
        handlersRef.current.updateResolvedDrop(currentDropPayload(location.current));
      },
      onDrop: ({ location }) => {
        const payload = currentDropPayload(location.current);
        handlersRef.current.monitorEvent('drop', payload);
        handlersRef.current.handleDrop(payload);
      },
    });
  }, []);

  return {
    isDraggingCategory,
    // The live drop target; the push-aside preview opens its gap there.
    dropIndicator,
    // The row whose navigation the ending drag suppresses.
    suppressedNavigationID: navigation.suppressedID,
    clearSuppressedNavigation: navigation.clear,
  };
}
