import { useRef, type RefObject } from 'react';
import { extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { SidebarSection } from '@/lib/sidebar-groups';
import type { SidebarCategory } from '@/types';
import {
  debugElapsedMs,
  sidebarDndDebug,
  type DragPayload,
  type DropPayload,
  type ResolvedDrop,
} from './sidebar-dnd-core';
import { sortedCategories } from './sidebar-drop-resolution';

// The opt-in drag-and-drop debug log (see sidebarDndDebug): every channel and
// category drag gets a sequence number, and each resolved target, drop and
// scheduled reorder is logged against it with the order it acted on. The
// trace only reads drag state — nothing it records decides where a drop lands.

interface DragTrace {
  sequence: number;
  startedAt: number | null;
  // The last resolution logged, so a pointer resting on one slot logs once.
  lastKey: string | null;
}

function describeDropPayload(payload: DropPayload | undefined) {
  if (!payload) return null;
  const edge = extractClosestEdge(payload);
  if (payload.type === 'channel-target') {
    return {
      type: payload.type,
      sectionKey: payload.sectionKey,
      index: payload.index,
      area: payload.area,
      edge,
    };
  }
  return {
    type: payload.type,
    sectionKey: payload.sectionKey,
    categoryID: payload.categoryID,
    edge,
  };
}

function describeResolvedDrop(drop: ResolvedDrop | null) {
  if (!drop) return null;
  if (drop.kind === 'channel') {
    return {
      kind: drop.kind,
      sectionKey: drop.sectionKey,
      index: drop.index,
      area: drop.area,
    };
  }
  return {
    kind: drop.kind,
    beforeCategoryID: drop.beforeCategoryID,
    position: drop.position,
  };
}

function categoryOrderDebugSnapshot(categories: SidebarCategory[]): Array<{ id: string; name: string; position: number }> {
  return sortedCategories(categories).map((category) => ({ id: category.id, name: category.name, position: category.position }));
}

function channelOrderDebugSnapshot(sections: SidebarSection[], sectionKey?: string) {
  return sections
    .filter((section) => sectionKey === undefined || section.key === sectionKey)
    .map((section) => ({
      sectionKey: section.key,
      title: section.title,
      // Include BOTH channels and conversations, in flat render order. The old
      // snapshot filtered to channels only, which hid favorited DMs — and since
      // Favorites is a flat position-sorted mix of channels AND DMs, that made a
      // drop's "reorder scheduled" numbers impossible to reconcile against the
      // log (the DM rows were invisible). Show every item so the order is whole.
      items: section.items.map((item, index) =>
        item.kind === 'channel'
          ? {
              index,
              kind: 'channel' as const,
              id: item.channel.channelID,
              name: item.channel.channelName,
              sidebarPosition: item.channel.sidebarPosition ?? null,
              favorite: !!item.channel.favorite,
            }
          : {
              index,
              kind: 'conversation' as const,
              id: item.conversation.conversationID,
              name: item.conversation.displayName,
              sidebarPosition: item.conversation.sidebarPosition ?? null,
              favorite: !!item.conversation.favorite,
            },
      ),
    }));
}

export function useSidebarDndTrace({
  sections,
  categories,
  activeDragRef,
  resolvedDropRef,
}: {
  sections: SidebarSection[];
  categories: SidebarCategory[];
  activeDragRef: RefObject<DragPayload | null>;
  resolvedDropRef: RefObject<ResolvedDrop | null>;
}) {
  const categoryTrace = useRef<DragTrace>({ sequence: 0, startedAt: null, lastKey: null });
  const channelTrace = useRef<DragTrace>({ sequence: 0, startedAt: null, lastKey: null });

  function dragStart(payload: DragPayload | null) {
    if (payload?.type === 'category') {
      const trace = categoryTrace.current;
      trace.sequence += 1;
      trace.startedAt = performance.now();
      trace.lastKey = null;
      sidebarDndDebug('category-drag start', {
        sequence: trace.sequence,
        categoryID: payload.categoryID,
        order: categoryOrderDebugSnapshot(categories),
      });
    }
    if (payload?.type === 'channel') {
      const trace = channelTrace.current;
      trace.sequence += 1;
      trace.startedAt = performance.now();
      trace.lastKey = null;
      sidebarDndDebug('channel-drag start', {
        sequence: trace.sequence,
        channelID: payload.channel.channelID,
        channelName: payload.channel.channelName,
        categoryID: payload.channel.categoryID ?? '',
        favorite: !!payload.channel.favorite,
      });
    }
  }

  // A drop-target change, or the drop itself, as the monitor saw it.
  function monitorEvent(event: 'dropTargetChange' | 'drop', payload: DropPayload | undefined) {
    const drag = activeDragRef.current;
    if (drag?.type === 'category') {
      sidebarDndDebug(`category-monitor ${event}`, {
        sequence: categoryTrace.current.sequence,
        draggedCategoryID: drag.categoryID,
        payload: describeDropPayload(payload),
        resolved: describeResolvedDrop(resolvedDropRef.current),
        elapsedMs: debugElapsedMs(categoryTrace.current.startedAt),
      });
    }
    if (drag?.type === 'channel') {
      sidebarDndDebug(`channel-monitor ${event}`, {
        sequence: channelTrace.current.sequence,
        draggedChannelID: drag.channel.channelID,
        payload: describeDropPayload(payload),
        resolved: describeResolvedDrop(resolvedDropRef.current),
        elapsedMs: debugElapsedMs(channelTrace.current.startedAt),
      });
    }
  }

  // The slot a hovered target resolved to, and the one the drag keeps
  // pointing at (effectiveChannelDrop: the new resolution, or the previous
  // channel slot held while the pointer crosses a gap). Called before
  // resolvedDropRef is updated, so it still holds the previous resolution.
  function targetResolved(
    payload: DropPayload | undefined,
    resolvedDrop: ResolvedDrop | null,
    effectiveChannelDrop: ResolvedDrop | null,
  ) {
    categoryTargetResolved(payload, resolvedDrop);
    channelTargetResolved(payload, resolvedDrop, effectiveChannelDrop);
  }

  function categoryTargetResolved(payload: DropPayload | undefined, resolvedDrop: ResolvedDrop | null) {
    const drag = activeDragRef.current;
    if (drag?.type !== 'category') return;
    const trace = categoryTrace.current;
    const key = JSON.stringify({
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDrop),
    });
    if (trace.lastKey === key) return;
    trace.lastKey = key;
    sidebarDndDebug('category-target resolved', {
      sequence: trace.sequence,
      draggedCategoryID: drag.categoryID,
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDrop),
      previousResolved: describeResolvedDrop(resolvedDropRef.current),
      order: categoryOrderDebugSnapshot(categories),
      elapsedMs: debugElapsedMs(trace.startedAt),
    });
  }

  function channelTargetResolved(
    payload: DropPayload | undefined,
    resolvedDrop: ResolvedDrop | null,
    effectiveDrop: ResolvedDrop | null,
  ) {
    const drag = activeDragRef.current;
    if (drag?.type !== 'channel') return;
    const trace = channelTrace.current;
    const key = JSON.stringify({
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDrop),
      effective: describeResolvedDrop(effectiveDrop),
    });
    if (trace.lastKey === key) return;
    trace.lastKey = key;
    /* v8 ignore next 4 -- debug-only; during a channel drag effectiveDrop is always a channel-kind drop, so the nested payload-based fallback arms are dead */
    /* istanbul ignore next -- debug-only; during a channel drag effectiveDrop is always a channel-kind drop, so the nested payload-based fallback arms are dead */
    const sectionKey = effectiveDrop?.kind === 'channel'
      ? effectiveDrop.sectionKey
      : payload?.type === 'channel-target' || payload?.type === 'section-header-target'
        ? payload.sectionKey
        : undefined;
    sidebarDndDebug('channel-target resolved', {
      sequence: trace.sequence,
      draggedChannelID: drag.channel.channelID,
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDrop),
      previousResolved: describeResolvedDrop(resolvedDropRef.current),
      effectiveResolved: describeResolvedDrop(effectiveDrop),
      keptPrevious: !resolvedDrop && effectiveDrop?.kind === 'channel',
      order: channelOrderDebugSnapshot(sections, sectionKey),
      elapsedMs: debugElapsedMs(trace.startedAt),
    });
  }

  function dropReceived(payload: DropPayload | undefined, resolvedDrop: ResolvedDrop | null) {
    const drag = activeDragRef.current;
    if (drag?.type === 'channel') {
      sidebarDndDebug('channel-drop received', {
        sequence: channelTrace.current.sequence,
        draggedChannelID: drag.channel.channelID,
        payload: describeDropPayload(payload),
        resolved: describeResolvedDrop(resolvedDrop),
        elapsedMs: debugElapsedMs(channelTrace.current.startedAt),
      });
    }
    if (drag?.type === 'category') {
      sidebarDndDebug('category-drop received', {
        sequence: categoryTrace.current.sequence,
        draggedCategoryID: drag.categoryID,
        payload: describeDropPayload(payload),
        resolved: describeResolvedDrop(resolvedDrop),
        order: categoryOrderDebugSnapshot(categories),
        elapsedMs: debugElapsedMs(categoryTrace.current.startedAt),
      });
    }
  }

  function dragEnd() {
    categoryTrace.current.startedAt = null;
    categoryTrace.current.lastKey = null;
    channelTrace.current.startedAt = null;
    channelTrace.current.lastKey = null;
  }

  // logChannel / logCategory log an event of the current channel / category
  // drag, tagged with its sequence number.
  function logChannel(event: string, details: Record<string, unknown>) {
    sidebarDndDebug(event, { sequence: channelTrace.current.sequence, ...details });
  }

  function logCategory(event: string, details: Record<string, unknown>) {
    sidebarDndDebug(event, { sequence: categoryTrace.current.sequence, ...details });
  }

  return {
    dragStart,
    monitorEvent,
    targetResolved,
    dropReceived,
    dragEnd,
    logChannel,
    logCategory,
    channelOrder: (sectionKey?: string) => channelOrderDebugSnapshot(sections, sectionKey),
    categoryOrder: () => categoryOrderDebugSnapshot(categories),
  };
}
