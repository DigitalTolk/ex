import type { CSSProperties } from 'react';
import type { UserChannel, UserConversation } from '@/types';

// Sidebar drag-and-drop core: payload/target types, drag-state constants,
// and the opt-in debug logging shared by the Pragmatic wrapper components
// (sidebar-dnd.tsx) and the Sidebar's drop-resolution handlers. Kept free
// of component exports so react-refresh can hot-reload the components.
export const CATEGORY_DROP_END = '__category-end__';
export const SIDEBAR_DND_DEBUG_STORAGE_KEY = 'ex.sidebarDndDebug';
export const SIDEBAR_DRAGGING_OPACITY = 0.25;
// When a channel/DM row is picked up, collapse its ORIGINAL slot to nothing
// (Slack-style "lift out") rather than leaving a dimmed in-place ghost — the
// ghost is confusing because you can drop above OR below the old position. The
// element stays MOUNTED (native HTML5 DnD needs its drag source to persist),
// just zero-sized and invisible; the push-aside gap alone then shows where it
// will land. Rows are direct `space-y-1` children (no wrapper div), so
// marginTop:0 here also eats the list gap and the slot fully vanishes.
export const SIDEBAR_DRAGGING_COLLAPSE: CSSProperties = {
  height: 0,
  minHeight: 0,
  marginTop: 0,
  marginBottom: 0,
  paddingTop: 0,
  paddingBottom: 0,
  overflow: 'hidden',
  opacity: 0,
  pointerEvents: 'none',
};
export type ChannelDropArea = 'lead' | 'row' | 'end';
export type ResolvedDrop =
  | { kind: 'channel'; sectionKey: string; index: number; area: ChannelDropArea }
  | { kind: 'category'; beforeCategoryID: string; position: number };
export type DropIndicator = ResolvedDrop;

export type DragPayload =
  | { type: 'channel'; channel: UserChannel }
  | { type: 'conversation'; conversation: UserConversation }
  | { type: 'category'; categoryID: string };

export type DropPayload =
  | { type: 'channel-target'; sectionKey: string; index: number; area: ChannelDropArea }
  | { type: 'section-header-target'; sectionKey: string; categoryID: string };

export function sidebarDndDebugEnabled(): boolean {
  try {
    return (
      localStorage.getItem(SIDEBAR_DND_DEBUG_STORAGE_KEY) === '1' ||
      window.location.search.includes('sidebarDndDebug=1')
    );
  } catch {
    return false;
  }
}

export function sidebarDndDebug(event: string, details?: Record<string, unknown>) {
  if (!sidebarDndDebugEnabled()) return;
  /* v8 ignore next -- debug-only logging; every call site passes a details object, so the ?? {} fallback is defensive */
  /* istanbul ignore next -- every call site passes a details object, so the ?? {} fallback arm is dead defensive code */
  console.debug(`[sidebar-dnd] ${event}`, details ?? {});
}

// debugElapsedMs reports how long the current drag has been active for the
// debug log. The startedAt ref is always set while a drag is in flight, so the
// null arm only exists defensively.
export function debugElapsedMs(startedAt: number | null): number | null {
  /* v8 ignore next -- the startedAt ref is always set during an active drag, so the ===null arm is dead (debug-only) */
  /* istanbul ignore next -- the startedAt ref is always set during an active drag, so the ===null arm is dead (debug-only) */
  return startedAt === null ? null : Math.round(performance.now() - startedAt);
}

export function elementDebugRect(element: Element) {
  const rect = element.getBoundingClientRect();
  return {
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    left: Math.round(rect.left),
    right: Math.round(rect.right),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

