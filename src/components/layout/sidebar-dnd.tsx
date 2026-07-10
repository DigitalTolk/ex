import { useCallback, useEffect, useLayoutEffect, useState, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  draggable as makeDraggable,
  dropTargetForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import { attachClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import type { UserChannel, UserConversation } from '@/types';
import {
  SIDEBAR_DRAGGING_COLLAPSE,
  SIDEBAR_DRAGGING_OPACITY,
  elementDebugRect,
  sidebarDndDebug,
  type DragPayload,
  type DropPayload,
} from './sidebar-dnd-core';

// The sidebar's Pragmatic drag-and-drop wrapper components: they register
// draggables/drop targets and expose render-prop refs/styles to the visual
// rows. Extracted from Sidebar.tsx so the list component owns only list
// composition and drop RESOLUTION (monitor wiring + computeSidebarReorder),
// which stays there — it is inseparable from the section data it reorders.

export function PragmaticCategoryHeader({
  id,
  draggable,
  dropData,
  className,
  testID,
  children,
}: {
  id: string;
  draggable: boolean;
  dropData?: DropPayload;
  className: string;
  testID: string;
  children: ReactNode;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const dropDataRef = useRef(dropData);
  const [dragging, setDragging] = useState(false);
  const hasDropData = dropData !== undefined;

  useLayoutEffect(() => {
    dropDataRef.current = dropData;
  }, [dropData]);

  useEffect(() => {
    const element = elementRef.current;
    /* v8 ignore next -- elementRef is always attached after mount; defensive null guard */
    /* istanbul ignore next -- elementRef is always attached after mount; defensive null guard */
    if (!element) return undefined;
    sidebarDndDebug('category-header register', {
      id,
      draggable,
      dropData: dropDataRef.current,
      rect: elementDebugRect(element),
    });
    const registrations = [];
    if (draggable) {
      registrations.push(
        makeDraggable({
          element,
          canDrag: ({ input }) => input.button === 0,
          getInitialData: () => ({ type: 'category', categoryID: id } satisfies DragPayload),
          onDragStart: () => {
            sidebarDndDebug('category-native dragStart', {
              id,
              rect: elementDebugRect(element),
            });
            setDragging(true);
          },
          onDrop: () => {
            sidebarDndDebug('category-native drop/end', {
              id,
              rect: elementDebugRect(element),
            });
            setDragging(false);
          },
        }),
      );
    }
    if (hasDropData) {
      registrations.push(
        dropTargetForElements({
          element,
          // Sticky so a category drag that moves onto the push-aside gap above a
          // section keeps this header as the target (see PragmaticChannelRow).
          getIsSticky: () => true,
          getData: ({ input, element }) => {
            const currentDropData = dropDataRef.current;
            /* v8 ignore next -- this drop target only registers when hasDropData, so dropDataRef is set; defensive guard */
            /* istanbul ignore next -- this drop target only registers when hasDropData, so dropDataRef is set; defensive guard */
            if (!currentDropData) return {};
            const data = attachClosestEdge(currentDropData, {
              input,
              element,
              allowedEdges: ['top', 'bottom'],
            });
            return data;
          },
        }),
      );
    }
    const cleanup = combine(...registrations);
    return () => {
      sidebarDndDebug('category-header unregister', { id });
      cleanup();
    };
  }, [draggable, hasDropData, id]);

  return (
    <div
      ref={elementRef}
      data-testid={testID}
      className={className}
      style={{ opacity: dragging ? SIDEBAR_DRAGGING_OPACITY : undefined }}
    >
      {children}
    </div>
  );
}

export function PragmaticSection({
  data,
  disabled,
  className,
  testID,
  children,
}: {
  data: DropPayload;
  disabled?: boolean;
  className?: string;
  testID?: string;
  children?: ReactNode;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef(data);

  useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || disabled) return undefined;
    return dropTargetForElements({
      element,
      // Sticky so the pointer entering an adjacent push-aside gap keeps a live
      // target (see PragmaticChannelRow) — no dead zone, no native snap-back.
      getIsSticky: () => true,
      getData: () => dataRef.current,
    });
  }, [disabled]);

  return (
    <div ref={elementRef} data-testid={testID} className={className}>
      {children}
    </div>
  );
}

export function PragmaticCategoryDropHitbox({
  active,
  data,
  testID,
}: {
  active: boolean;
  data: DropPayload;
  testID: string;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef(data);

  useLayoutEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    const element = elementRef.current;
    /* v8 ignore next -- elementRef is always attached after mount; defensive null guard */
    /* istanbul ignore next -- elementRef is always attached after mount; defensive null guard */
    if (!element) return undefined;
    return dropTargetForElements({
      element,
      // Sticky (see PragmaticChannelRow): keeps this boundary as the target when
      // the pointer slides onto the adjacent push-aside gap.
      getIsSticky: () => true,
      getData: () => dataRef.current,
    });
  }, []);

  return (
    <div
      ref={elementRef}
      data-testid={testID}
      className={`absolute -top-3 left-0 right-0 z-20 h-6 ${
        active ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
    />
  );
}

export function PragmaticChannelRow({
  sectionKey,
  index,
  channel,
  disabled,
  children,
}: {
  sectionKey: string;
  index: number;
  channel: UserChannel;
  disabled?: boolean;
  children: (args: {
    dragRef?: (node: HTMLElement | null) => void;
    dragStyle?: CSSProperties;
  }) => ReactNode;
}) {
  const elementRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || disabled) return undefined;
    return combine(
      makeDraggable({
        element,
        canDrag: ({ input }) => input.button === 0,
        getInitialData: () => ({ type: 'channel', channel } satisfies DragPayload),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        // Sticky: when the pointer leaves this row onto the push-aside gap — a
        // pointer-events-none LAYOUT box that is NOT itself a drop target —
        // pragmatic RETAINS this row as the active target and reuses its last
        // closest-edge (it deliberately doesn't recompute getData while sticky).
        // Without this, hovering the gap leaves NO drop target under the cursor,
        // so the browser never gets preventDefault → it rejects the drop with the
        // native return-to-origin animation (the "snap-back") and the reorder
        // never lands. Stickiness keeps a target under the cursor across the gap.
        getIsSticky: () => true,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { type: 'channel-target', sectionKey, index, area: 'row' } satisfies DropPayload,
            {
              input,
              element,
              allowedEdges: ['top', 'bottom'],
            },
          ),
      }),
    );
  }, [channel, disabled, index, sectionKey]);

  const setElementRef = useCallback((node: HTMLElement | null) => {
    elementRef.current = node;
  }, []);

  return (
    <>
      {/* eslint-disable-next-line react-hooks/refs -- passing ref callbacks to a child render prop; refs are only assigned by React later. */}
      {children({
        dragRef: setElementRef,
        dragStyle: dragging ? SIDEBAR_DRAGGING_COLLAPSE : undefined,
      })}
    </>
  );
}

export function PragmaticConversationRow({
  sectionKey,
  index,
  conversation,
  disabled,
  children,
}: {
  sectionKey: string;
  index: number;
  conversation: UserConversation;
  disabled?: boolean;
  children: (args: {
    dragRef?: (node: HTMLElement | null) => void;
    dragStyle?: CSSProperties;
  }) => ReactNode;
}) {
  const elementRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    /* v8 ignore next -- elementRef is always attached after mount; the !element arm is defensive */
    /* istanbul ignore next -- elementRef is always attached after mount; the !element arm is defensive */
    if (!element || disabled) return undefined;
    return combine(
      makeDraggable({
        element,
        canDrag: ({ input }) => input.button === 0,
        getInitialData: () => ({ type: 'conversation', conversation } satisfies DragPayload),
        onDragStart: () => setDragging(true),
        onDrop: () => setDragging(false),
      }),
      dropTargetForElements({
        element,
        // Sticky: when the pointer leaves this row onto the push-aside gap — a
        // pointer-events-none LAYOUT box that is NOT itself a drop target —
        // pragmatic RETAINS this row as the active target and reuses its last
        // closest-edge (it deliberately doesn't recompute getData while sticky).
        // Without this, hovering the gap leaves NO drop target under the cursor,
        // so the browser never gets preventDefault → it rejects the drop with the
        // native return-to-origin animation (the "snap-back") and the reorder
        // never lands. Stickiness keeps a target under the cursor across the gap.
        getIsSticky: () => true,
        getData: ({ input, element }) =>
          attachClosestEdge(
            { type: 'channel-target', sectionKey, index, area: 'row' } satisfies DropPayload,
            {
              input,
              element,
              allowedEdges: ['top', 'bottom'],
            },
          ),
      }),
    );
  }, [conversation, disabled, index, sectionKey]);

  const setElementRef = useCallback((node: HTMLElement | null) => {
    elementRef.current = node;
  }, []);

  return (
    <>
      {/* eslint-disable-next-line react-hooks/refs -- passing ref callbacks to a child render prop; refs are only assigned by React later. */}
      {children({
        dragRef: setElementRef,
        dragStyle: dragging ? SIDEBAR_DRAGGING_COLLAPSE : undefined,
      })}
    </>
  );
}
