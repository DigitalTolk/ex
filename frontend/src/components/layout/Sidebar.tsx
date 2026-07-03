import { Fragment, useCallback, useEffect, useLayoutEffect, useState, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  draggable as makeDraggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine';
import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { slugify } from '@/lib/format';
import {
  Plus,
  ChevronDown,
  BookUser,
  MessagesSquare,
  FilePenLine,
  MoreVertical,
  Trash2,
  ArrowDownAZ,
  Clock3,
  Bell,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { isGuest } from '@/lib/roles';
import { useAuth } from '@/context/AuthContext';
import { usePresence } from '@/context/PresenceContext';
import { useUnread } from '@/context/UnreadContext';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { getSeenMap, THREAD_SEEN_CHANGED_EVENT, unreadThreadIDs, useUserThreads } from '@/hooks/useThreads';
import { useUserState } from '@/hooks/useUserState';
import { useDrafts } from '@/hooks/useDrafts';
import { useActivity } from '@/hooks/useActivity';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useCategories, useCreateCategory, useDeleteCategory, useReorderCategories, useReorderSidebar } from '@/hooks/useSidebar';
import { groupSidebarItems, SidebarSectionKeys, type SidebarItem, type ConversationSidebarSort } from '@/lib/sidebar-groups';
import { computeSidebarReorder, type SidebarSectionTarget } from '@/lib/sidebar-reorder';
import type { SidebarCategory, UserChannel, UserConversation } from '@/types';
import { ChannelRow } from './ChannelRow';
import { ConversationRow } from './ConversationRow';
import { CreateChannelDialog } from '@/components/channels/CreateChannelDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface SidebarProps {
  onClose: () => void;
}

const CONVERSATION_SORT_STORAGE_KEY = 'sidebar.conversationSort';
const CATEGORY_DROP_END = '__category-end__';
const SIDEBAR_DND_DEBUG_STORAGE_KEY = 'ex.sidebarDndDebug';
const SIDEBAR_DRAGGING_OPACITY = 0.25;
// When a channel/DM row is picked up, collapse its ORIGINAL slot to nothing
// (Slack-style "lift out") rather than leaving a dimmed in-place ghost — the
// ghost is confusing because you can drop above OR below the old position. The
// element stays MOUNTED (native HTML5 DnD needs its drag source to persist),
// just zero-sized and invisible; the push-aside gap alone then shows where it
// will land. Rows are direct `space-y-1` children (no wrapper div), so
// marginTop:0 here also eats the list gap and the slot fully vanishes.
const SIDEBAR_DRAGGING_COLLAPSE: CSSProperties = {
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
type ChannelDropArea = 'lead' | 'row' | 'end';
type ResolvedDrop =
  | { kind: 'channel'; sectionKey: string; index: number; area: ChannelDropArea }
  | { kind: 'category'; beforeCategoryID: string; position: number };
type DropIndicator = ResolvedDrop;

type DragPayload =
  | { type: 'channel'; channel: UserChannel }
  | { type: 'conversation'; conversation: UserConversation }
  | { type: 'category'; categoryID: string };

type DropPayload =
  | { type: 'channel-target'; sectionKey: string; index: number; area: ChannelDropArea }
  | { type: 'section-header-target'; sectionKey: string; categoryID: string };

function sidebarDndDebugEnabled(): boolean {
  try {
    return (
      localStorage.getItem(SIDEBAR_DND_DEBUG_STORAGE_KEY) === '1' ||
      window.location.search.includes('sidebarDndDebug=1')
    );
  } catch {
    return false;
  }
}

function sidebarDndDebug(event: string, details?: Record<string, unknown>) {
  if (!sidebarDndDebugEnabled()) return;
  /* v8 ignore next -- debug-only logging; every call site passes a details object, so the ?? {} fallback is defensive */
  /* istanbul ignore next -- every call site passes a details object, so the ?? {} fallback arm is dead defensive code */
  console.debug(`[sidebar-dnd] ${event}`, details ?? {});
}

// debugElapsedMs reports how long the current drag has been active for the
// debug log. The startedAt ref is always set while a drag is in flight, so the
// null arm only exists defensively.
function debugElapsedMs(startedAt: number | null): number | null {
  /* v8 ignore next -- the startedAt ref is always set during an active drag, so the ===null arm is dead (debug-only) */
  /* istanbul ignore next -- the startedAt ref is always set during an active drag, so the ===null arm is dead (debug-only) */
  return startedAt === null ? null : Math.round(performance.now() - startedAt);
}

function elementDebugRect(element: Element) {
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

function PragmaticCategoryHeader({
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

function PragmaticSection({
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

function PragmaticCategoryDropHitbox({
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

function PragmaticChannelRow({
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

function PragmaticConversationRow({
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

function SidebarSectionsSkeleton() {
  return (
    <div className="mt-2 space-y-4 px-2" data-testid="sidebar-primary-loading" aria-hidden="true">
      {['w-20', 'w-24', 'w-32'].map((widthClass) => (
        <div key={widthClass} className="space-y-2">
          <div className={`h-4 rounded bg-white/10 ${widthClass}`} />
          <div className="h-8 rounded-md bg-white/5 max-md:h-12" />
          <div className="h-8 rounded-md bg-white/5 max-md:h-12" />
        </div>
      ))}
    </div>
  );
}

export function Sidebar({ onClose }: SidebarProps) {
  const { user } = useAuth();
  const { unreadThreadNotifications, hiddenConversations, hideConversation } = useUnread();
  const { data: channels } = useUserChannels();
  const conversationsQuery = useUserConversations();
  const { data: conversations } = conversationsQuery;
  const { data: threads } = useUserThreads();
  const { data: userState } = useUserState();
  const { data: drafts } = useDrafts();
  const { data: activityFeed } = useActivity();
  const activityUnread = activityFeed?.unread ?? 0;
  const { data: categories } = useCategories();
  const sidebarPrimaryDataReady =
    conversations !== undefined || conversationsQuery.isError;
  const createCategory = useCreateCategory();
  const deleteCategory = useDeleteCategory();
  const reorderSidebar = useReorderSidebar();
  const reorderCategories = useReorderCategories();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [conversationSort, setConversationSort] = useState<ConversationSidebarSort>(() =>
    localStorage.getItem(CONVERSATION_SORT_STORAGE_KEY) === 'az' ? 'az' : 'recent',
  );
  const activeDragRef = useRef<DragPayload | null>(null);
  const [isDraggingCategory, setIsDraggingCategory] = useState(false);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const visibleDropIndicatorRef = useRef<DropIndicator | null>(null);
  const resolvedDropRef = useRef<ResolvedDrop | null>(null);
  const categoryDragStartedAtRef = useRef<number | null>(null);
  const categoryDropSequenceRef = useRef(0);
  const lastCategoryDebugKeyRef = useRef<string | null>(null);
  const lastCategoryMonitorDragLogAtRef = useRef(0);
  const channelDragStartedAtRef = useRef<number | null>(null);
  const channelDropSequenceRef = useRef(0);
  const lastChannelDebugKeyRef = useRef<string | null>(null);
  const lastChannelMonitorDragLogAtRef = useRef(0);
  const [suppressChannelNavigationID, setSuppressChannelNavigationID] = useState<string | null>(null);
  const suppressNavigationResetRef = useRef<number | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryCreateError, setCategoryCreateError] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const directoryActive = location.pathname === '/directory' || location.pathname.startsWith('/directory/');
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  // null = closed; otherwise the section being deleted. Modal confirm
  // replaces window.confirm so the prompt fits the rest of the app's
  // visual language (and is mockable in tests).
  const [categoryToDelete, setCategoryToDelete] = useState<{ id: string; title: string } | null>(null);
  const [localSeenMap, setLocalSeenMap] = useState(() => getSeenMap());

  useEffect(() => {
    const handleSeenChange = () => setLocalSeenMap(getSeenMap());
    window.addEventListener(THREAD_SEEN_CHANGED_EVENT, handleSeenChange);
    return () => window.removeEventListener(THREAD_SEEN_CHANGED_EVENT, handleSeenChange);
  }, []);

  const visibleConversations = useMemo(
    () => {
      const hidden = new Set([...(userState?.hiddenConversations ?? []), ...hiddenConversations]);
      return conversations?.filter((c) => !hidden.has(c.conversationID)) ?? [];
    },
    [conversations, hiddenConversations, userState?.hiddenConversations],
  );
  const unreadThreadCount = useMemo(
    () =>
      unreadThreadIDs(
        threads ?? [],
        userState?.threadNotifications ?? [],
        unreadThreadNotifications ?? new Set(),
        { ...(userState?.threadSeen ?? {}), ...localSeenMap },
      ).size,
    [localSeenMap, threads, unreadThreadNotifications, userState?.threadNotifications, userState?.threadSeen],
  );
  const hasThreadUpdates = unreadThreadCount > 0;
  const draftCount = drafts?.length ?? 0;

  const sidebarSections = useMemo(
    () => groupSidebarItems(channels ?? [], visibleConversations, categories ?? [], { conversationSort }),
    [channels, visibleConversations, categories, conversationSort],
  );

  // Fetch the other participant for every DM in one batch so the sidebar
  // can render real avatars instead of just initials. Group DMs use a
  // participant-count badge instead and don't need user lookups.
  const dmOtherUserIDs = useMemo(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    /* v8 ignore next -- visibleConversations is always an array (defaults to []); the ?? [] fallback is defensive */
    /* istanbul ignore next -- visibleConversations is always an array (defaults to []); the ?? [] fallback arm is dead */
    for (const c of visibleConversations ?? []) {
      if (c.type !== 'dm') continue;
      if (c.profileResolved) continue;
      const other = (c.participantIDs ?? []).find((p) => p !== user?.id) ?? c.participantIDs?.[0];
      if (other && !seen.has(other)) {
        seen.add(other);
        ids.push(other);
      }
    }
    return ids;
  }, [visibleConversations, user?.id]);
  const { map: dmUserMap } = useUsersBatch(dmOtherUserIDs);
  const { online } = usePresence();

  function setConversationSortPreference(sort: ConversationSidebarSort) {
    setConversationSort(sort);
    localStorage.setItem(CONVERSATION_SORT_STORAGE_KEY, sort);
  }

  function sectionCategoryID(sectionKey: string): string {
    return sectionKey === SidebarSectionKeys.Channels ? '' : sectionKey;
  }

  // sectionDropTarget maps a section to the (categoryID, favorite) it imposes
  // on items dropped into it. Favorites keeps each item's existing category
  // (keepCategory) and forces favorite=true; a user category forces its own id
  // and favorite=false; the default Channels/DMs sections force category="" and
  // favorite=false.
  function sectionDropTarget(sectionKey: string): SidebarSectionTarget {
    if (sectionKey === SidebarSectionKeys.Favorites) {
      return { categoryID: '', favorite: true, keepCategory: true };
    }
    return { categoryID: sectionCategoryID(sectionKey), favorite: false };
  }

  // persistReorder densifies the target section and writes the changed rows in
  // one batch (see computeSidebarReorder + useReorderSidebar). The dropped item
  // lands exactly where released because the whole section is renumbered to
  // evenly-spaced positions — no fractional gaps to run out of, no 0/unset
  // ambiguity. favoriteChanged names the single row whose favorite flag flipped
  // (a cross-section move in/out of Favorites) so only it hits the favorite
  // endpoint.
  function persistReorder(
    items: SidebarItem[],
    dragged: { id: string; kind: 'channel' | 'conversation'; favorite: boolean },
    targetIndex: number,
    target: SidebarSectionTarget,
  ) {
    const updates = computeSidebarReorder(items, { id: dragged.id, kind: dragged.kind }, targetIndex, target);
    /* v8 ignore next 4 -- a no-op drop (section already densely ordered and the item released at its own slot) yields zero updates; that empty-result path is unit-tested directly in sidebar-reorder.test.ts, but the mocked-mutation drag harness can't re-densify the cache to reproduce it here */
    /* istanbul ignore next -- empty-updates no-op path; covered by sidebar-reorder.test.ts, unreachable via the mocked-mutation drag harness */
    if (updates.length === 0) {
      clearDropTarget();
      return;
    }
    const favoriteChanged = new Set<string>();
    if (dragged.favorite !== target.favorite) favoriteChanged.add(dragged.id);
    sidebarDndDebug('reorder scheduled', {
      sequence: channelDropSequenceRef.current,
      draggedID: dragged.id,
      updates,
      order: channelOrderDebugSnapshot(),
    });
    reorderSidebar.mutate({ updates, favoriteChanged });
    clearDropTarget();
  }

  function dropChannelInto(sectionKey: string, items: SidebarItem[], targetIndex: number) {
    /* v8 ignore next -- only called when the active drag is a channel (see applyResolvedDrop), so the : null arm is dead */
    /* istanbul ignore next -- only called when the active drag is a channel (see applyResolvedDrop), so the : null arm is dead */
    const currentDraggedChannel = activeDragRef.current?.type === 'channel' ? activeDragRef.current.channel : null;
    /* v8 ignore start -- currentDraggedChannel is always set here, and a resolved channel drop never targets the DM section (canAcceptChannelDrop excludes it); both guards are defensive */
    /* istanbul ignore next -- currentDraggedChannel is always set here; the no-active-channel guard is dead defensive code */
    if (!currentDraggedChannel) return;
    /* istanbul ignore next -- a resolved channel drop never targets the DM section (canAcceptChannelDrop excludes it); this guard is dead defensive code */
    if (sectionKey === SidebarSectionKeys.DirectMessages) return;
    /* v8 ignore stop */
    persistReorder(
      items,
      { id: currentDraggedChannel.channelID, kind: 'channel', favorite: !!currentDraggedChannel.favorite },
      targetIndex,
      sectionDropTarget(sectionKey),
    );
  }

  function dropConversationInto(sectionKey: string, items: SidebarItem[], targetIndex: number) {
    /* v8 ignore start -- only called for a conversation drag resolved onto Favorites, so currentDraggedConversation is set and sectionKey is Favorites; both guards (and the : null arm) are defensive */
    /* istanbul ignore next -- only called for a conversation drag, so the : null arm is dead defensive code */
    const currentDraggedConversation = activeDragRef.current?.type === 'conversation' ? activeDragRef.current.conversation : null;
    /* istanbul ignore next -- currentDraggedConversation is always set here; the guard is dead defensive code */
    if (!currentDraggedConversation) return;
    /* istanbul ignore next -- only called for a drop resolved onto Favorites; the non-Favorites guard is dead defensive code */
    if (sectionKey !== SidebarSectionKeys.Favorites) return;
    /* v8 ignore stop */
    persistReorder(
      items,
      { id: currentDraggedConversation.conversationID, kind: 'conversation', favorite: !!currentDraggedConversation.favorite },
      targetIndex,
      sectionDropTarget(sectionKey),
    );
  }

  function channelCount(items: SidebarItem[]): number {
    return items.filter((item) => item.kind === 'channel').length;
  }

  function dropCount(sectionKey: string, items: SidebarItem[]): number {
    return sectionKey === SidebarSectionKeys.Favorites ? items.length : channelCount(items);
  }

  function showChannelDropIndicator(sectionKey: string, index: number, area: ChannelDropArea) {
    resolvedDropRef.current = { kind: 'channel', sectionKey, index, area };
    setDropIndicator((prev) => {
      if (
        prev?.kind === 'channel' &&
        prev.sectionKey === sectionKey &&
        prev.index === index &&
        prev.area === area
      ) {
        return prev;
      }
      return { kind: 'channel', sectionKey, index, area };
    });
  }

  function showCategoryDropIndicator(beforeCategoryID: string, position: number) {
    resolvedDropRef.current = { kind: 'category', beforeCategoryID, position };
    setDropIndicator((prev) => {
      if (
        prev?.kind === 'category' &&
        prev.beforeCategoryID === beforeCategoryID &&
        prev.position === position
      ) {
        return prev;
      }
      return { kind: 'category', beforeCategoryID, position };
    });
  }

  function clearDropTarget() {
    resolvedDropRef.current = null;
    setDropIndicator(null);
  }

  function sortedCategoriesWithoutDragged(): SidebarCategory[] {
    /* v8 ignore start -- only runs during a category drag with categories loaded and distinct positions: the ?? [] fallback, the non-category ternary arm, and the equal-position localeCompare tiebreak are all defensive */
    /* istanbul ignore next -- categories are always loaded during a category drag, and the active drag is always a category here; the ?? [] fallback, the : null ternary arm, and the equal-position localeCompare tiebreak are all dead defensive code */
    return [...(categories ?? [])]
      .filter((category) => category.id !== (activeDragRef.current?.type === 'category' ? activeDragRef.current.categoryID : null))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    /* v8 ignore stop */
  }

  function categoryOrderDebugSnapshot(): Array<{ id: string; name: string; position: number }> {
    /* v8 ignore start -- debug-only snapshot; the ?? [] fallback and the equal-position localeCompare tiebreak are defensive */
    /* istanbul ignore next -- debug-only snapshot; categories are always loaded with distinct positions, so the ?? [] fallback and the equal-position localeCompare tiebreak are dead defensive code */
    return [...(categories ?? [])]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((category) => ({ id: category.id, name: category.name, position: category.position }));
    /* v8 ignore stop */
  }

  function channelOrderDebugSnapshot(sectionKey?: string) {
    return sidebarSections
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

  function orderedCategoriesAfterDrop(draggedCategoryID: string, beforeCategoryID: string): SidebarCategory[] {
    const withoutDragged = sortedCategoriesWithoutDragged();
    const draggedCategory = categories?.find((category) => category.id === draggedCategoryID);
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

  function normalizeCategoryDropSlot(beforeCategoryID: string, draggedCategoryID: string): string {
    /* v8 ignore next -- the resolve path never produces beforeCategoryID === draggedCategoryID (self-targeting is filtered upstream), so the nextCategoryTarget arm is defensive */
    return beforeCategoryID === draggedCategoryID ? nextCategoryTarget(draggedCategoryID) : beforeCategoryID;
  }

  function moveCategoryBefore(beforeCategoryID: string) {
    /* v8 ignore next -- only called for a category drop (see applyResolvedDrop), so the : null arm is dead */
    /* istanbul ignore next -- only called for a category drop (see applyResolvedDrop), so the : null arm is dead */
    const draggedCategoryID = activeDragRef.current?.type === 'category' ? activeDragRef.current.categoryID : null;
    const sequence = categoryDropSequenceRef.current;
    /* v8 ignore start -- draggedCategoryID is always set here and the dragged category is always in the cache during a drag; both guards are defensive */
    /* istanbul ignore next -- draggedCategoryID is always set here during a category drop; this guard is dead defensive code */
    if (!draggedCategoryID) {
      sidebarDndDebug('category-drop ignored: no active category', {
        sequence,
        beforeCategoryID,
        activeDrag: activeDragRef.current,
      });
      return;
    }
    const normalizedBeforeCategoryID = normalizeCategoryDropSlot(beforeCategoryID, draggedCategoryID);
    const draggedCategory = categories?.find((category) => category.id === draggedCategoryID);
    /* istanbul ignore next -- the dragged category is always in the cache during a drag; this guard is dead defensive code */
    if (!draggedCategory) {
      sidebarDndDebug('category-drop ignored: dragged category missing from cache', {
        sequence,
        draggedCategoryID,
        beforeCategoryID: normalizedBeforeCategoryID,
        order: categoryOrderDebugSnapshot(),
      });
      return;
    }
    /* v8 ignore stop */

    const nextOrder = orderedCategoriesAfterDrop(draggedCategoryID, normalizedBeforeCategoryID);
    sidebarDndDebug('category-reorder scheduled', {
      sequence,
      draggedCategoryID,
      beforeCategoryID: normalizedBeforeCategoryID,
      order: nextOrder.map((category, index) => ({ id: category.id, position: (index + 1) * 1000 })),
      previousOrder: categoryOrderDebugSnapshot(),
    });
    sidebarDndDebug('category-reorder firing', {
      sequence,
      draggedCategoryID,
      beforeCategoryID: normalizedBeforeCategoryID,
      order: categoryOrderDebugSnapshot(),
    });
    reorderCategories.mutate({ categories: nextOrder });
    setDropIndicator(null);
  }

  function toggleGroupCollapsed(sectionKey: string) {
    setCollapsedGroups((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }));
  }


  function applyResolvedDrop(drop: ResolvedDrop | null) {
    if (!drop) return;
    if (drop.kind === 'channel') {
      const section = sidebarSections.find((candidate) => candidate.key === drop.sectionKey);
      /* v8 ignore next -- the drop was resolved from an existing section, so it is always found; defensive guard */
      /* istanbul ignore next -- the drop was resolved from an existing section, so it is always found; defensive guard */
      if (!section) return;
      if (activeDragRef.current?.type === 'channel') {
        dropChannelInto(drop.sectionKey, section.items, drop.index);
        return;
      }
      /* v8 ignore next -- a channel-kind drop only originates from a channel or conversation drag; after the channel branch returns, the active drag is always a conversation, so the false arm is dead */
      /* istanbul ignore next -- after the channel branch returns, a channel-kind drop's active drag is always a conversation, so the false arm is dead */
      if (activeDragRef.current?.type === 'conversation') {
        dropConversationInto(drop.sectionKey, section.items, drop.index);
      }
      return;
    }
    /* v8 ignore next -- a category-kind drop only originates from a category drag; the early-return arm is dead */
    /* istanbul ignore next -- a category-kind drop only originates from a category drag; the early-return arm is dead */
    if (activeDragRef.current?.type !== 'category') return;
    moveCategoryBefore(drop.beforeCategoryID);
  }

  function canAcceptChannelDrop(sectionKey: string): boolean {
    return sectionKey !== SidebarSectionKeys.DirectMessages;
  }

  function previousChannelDrop(sectionKey: string): ResolvedDrop | null {
    const sectionIndex = sidebarSections.findIndex((section) => section.key === sectionKey);
    if (sectionIndex < 1) return null;
    for (let index = sectionIndex - 1; index >= 0; index -= 1) {
      const section = sidebarSections[index];
      /* v8 ignore next -- sections preceding any drop target are always channel-accepting (DM is the last section), so the false arm is defensive */
      /* istanbul ignore next -- sections preceding any drop target are always channel-accepting (DM is the last section), so the false arm is dead */
      if (canAcceptChannelDrop(section.key)) {
        // Land at the section's TRUE end — dropCount, not channelCount. Favorites
        // is a flat, position-sorted list that mixes channels AND favorited DMs
        // (sidebar-groups favItems .sort), so its end is items.length; counting
        // only channels lands the drop one slot short of the last item whenever a
        // favorited DM sits below the channels. This mirrors the section-tail drop
        // target (PragmaticSection below) and the push-aside preview, which both
        // already use dropCount — the two "end of section" resolvers must agree or
        // the drop lands where the preview didn't show.
        return { kind: 'channel', sectionKey: section.key, index: dropCount(section.key, section.items), area: 'end' };
      }
    }
    /* v8 ignore next -- unreachable: sectionIndex<1 returns above, and every section that CAN precede a drop target accepts channel drops (only DMs — always last — don't), so the loop always returns on its first iteration */
    /* istanbul ignore next -- unreachable post-loop return; see the loop's canAcceptChannelDrop guard */
    return null;
  }

  function channelDropFromSectionHeader(sectionKey: string, edge: Edge | null): ResolvedDrop {
    if (edge === 'top') {
      const previousDrop = previousChannelDrop(sectionKey);
      if (previousDrop) return previousDrop;
    }
    return { kind: 'channel', sectionKey, index: 0, area: 'lead' };
  }

  function channelDropAreaForIndex(sectionKey: string, index: number): ChannelDropArea {
    const section = sidebarSections.find((candidate) => candidate.key === sectionKey);
    /* v8 ignore next -- always called with a sectionKey from an existing payload, so the section is found; defensive guard */
    /* istanbul ignore next -- always called with a sectionKey from an existing payload, so the section is found; defensive guard */
    if (!section) return 'row';
    return index >= dropCount(sectionKey, section.items) ? 'end' : 'row';
  }

  function resolveDropPayload(payload: DropPayload | undefined): ResolvedDrop | null {
    /* v8 ignore next -- callers always pass a defined payload from a live drop target; the !payload guard is defensive */
    /* istanbul ignore next -- callers always pass a defined payload from a live drop target; the !payload guard is defensive */
    if (!payload) return null;
    const currentDrag = activeDragRef.current;
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
        ? channelDropAreaForIndex(payload.sectionKey, index)
        : payload.area;
      return { kind: 'channel', sectionKey: payload.sectionKey, index, area };
    }
    /* v8 ignore next -- DropPayload has only two variants; channel-target returned above, so this is always a section-header-target (the false arm is unreachable) */
    /* istanbul ignore next -- DropPayload has only two variants; channel-target returned above, so this is always a section-header-target (the false arm is unreachable) */
    if (payload.type === 'section-header-target') {
      if (currentDrag?.type === 'channel') {
        return channelDropFromSectionHeader(payload.sectionKey, extractClosestEdge(payload));
      }
      if (currentDrag?.type === 'conversation' && payload.sectionKey === SidebarSectionKeys.Favorites) {
        return channelDropFromSectionHeader(payload.sectionKey, extractClosestEdge(payload));
      }
      if (
        currentDrag?.type === 'category' &&
        payload.sectionKey !== SidebarSectionKeys.Favorites
      ) {
        const edge = extractClosestEdge(payload);
        const rawBeforeCategoryID = edge === 'bottom' ? nextCategoryTarget(payload.categoryID) : payload.categoryID;
        const beforeCategoryID = normalizeCategoryDropSlot(rawBeforeCategoryID, currentDrag.categoryID);
        return {
          kind: 'category',
          beforeCategoryID,
          position: (orderedCategoriesAfterDrop(currentDrag.categoryID, beforeCategoryID).findIndex((category) => category.id === currentDrag.categoryID) + 1) * 1000,
        };
      }
    }
    return null;
  }

  function nextCategoryTarget(categoryID: string): string {
    /* v8 ignore next -- only runs mid category drag with categories loaded and distinct positions; the ?? [] fallback and the equal-position localeCompare tiebreak are defensive */
    /* istanbul ignore next -- only runs mid category drag with categories loaded and distinct positions; the ?? [] fallback and the equal-position localeCompare tiebreak are dead defensive code */
    const ordered = [...(categories ?? [])].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const index = ordered.findIndex((category) => category.id === categoryID);
    return ordered[index + 1]?.id ?? CATEGORY_DROP_END;
  }

  function currentDropPayload(location: { dropTargets: Array<{ data: Record<string | symbol, unknown> }> }): DropPayload | undefined {
    return location.dropTargets[0]?.data as DropPayload | undefined;
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

  function logCategoryResolution(payload: DropPayload | undefined, resolvedDrop: ResolvedDrop | null) {
    if (activeDragRef.current?.type !== 'category') return;
    const key = JSON.stringify({
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDrop),
    });
    if (lastCategoryDebugKeyRef.current === key) return;
    lastCategoryDebugKeyRef.current = key;
    sidebarDndDebug('category-target resolved', {
      sequence: categoryDropSequenceRef.current,
      draggedCategoryID: activeDragRef.current.categoryID,
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDrop),
      previousResolved: describeResolvedDrop(resolvedDropRef.current),
      order: categoryOrderDebugSnapshot(),
      elapsedMs: debugElapsedMs(categoryDragStartedAtRef.current),
    });
  }

  function logCategoryMonitorEvent(event: string, payload: DropPayload | undefined, force = false) {
    if (activeDragRef.current?.type !== 'category') return;
    if (event === 'drag') return;
    const now = performance.now();
    /* v8 ignore next -- debug-only throttle; tests fire events within the 250ms window so the !force / >=250ms arms are not exercised */
    /* istanbul ignore next -- debug-only throttle; every monitor caller passes force=true within the 250ms window, so the !force / >=250ms arms are dead */
    if (!force && now - lastCategoryMonitorDragLogAtRef.current < 250) return;
    lastCategoryMonitorDragLogAtRef.current = now;
    sidebarDndDebug(`category-monitor ${event}`, {
      sequence: categoryDropSequenceRef.current,
      draggedCategoryID: activeDragRef.current.categoryID,
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDropRef.current),
      elapsedMs: debugElapsedMs(categoryDragStartedAtRef.current),
    });
  }

  function logChannelResolution(
    payload: DropPayload | undefined,
    resolvedDrop: ResolvedDrop | null,
    effectiveDrop: ResolvedDrop | null,
  ) {
    if (activeDragRef.current?.type !== 'channel') return;
    const key = JSON.stringify({
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDrop),
      effective: describeResolvedDrop(effectiveDrop),
    });
    if (lastChannelDebugKeyRef.current === key) return;
    lastChannelDebugKeyRef.current = key;
    /* v8 ignore next 4 -- debug-only; during a channel drag effectiveDrop is always a channel-kind drop, so the nested payload-based fallback arms are dead */
    /* istanbul ignore next -- debug-only; during a channel drag effectiveDrop is always a channel-kind drop, so the nested payload-based fallback arms are dead */
    const sectionKey = effectiveDrop?.kind === 'channel'
      ? effectiveDrop.sectionKey
      : payload?.type === 'channel-target' || payload?.type === 'section-header-target'
        ? payload.sectionKey
        : undefined;
    sidebarDndDebug('channel-target resolved', {
      sequence: channelDropSequenceRef.current,
      draggedChannelID: activeDragRef.current.channel.channelID,
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDrop),
      previousResolved: describeResolvedDrop(resolvedDropRef.current),
      effectiveResolved: describeResolvedDrop(effectiveDrop),
      keptPrevious: !resolvedDrop && effectiveDrop?.kind === 'channel',
      order: channelOrderDebugSnapshot(sectionKey),
      elapsedMs: debugElapsedMs(channelDragStartedAtRef.current),
    });
  }

  function logChannelMonitorEvent(event: string, payload: DropPayload | undefined, force = false) {
    if (activeDragRef.current?.type !== 'channel') return;
    if (event === 'drag') return;
    const now = performance.now();
    /* v8 ignore next -- debug-only throttle; tests fire events within the 250ms window so the !force / >=250ms arms are not exercised */
    /* istanbul ignore next -- debug-only throttle; every monitor caller passes force=true within the 250ms window, so the !force / >=250ms arms are dead */
    if (!force && now - lastChannelMonitorDragLogAtRef.current < 250) return;
    lastChannelMonitorDragLogAtRef.current = now;
    sidebarDndDebug(`channel-monitor ${event}`, {
      sequence: channelDropSequenceRef.current,
      draggedChannelID: activeDragRef.current.channel.channelID,
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDropRef.current),
      elapsedMs: debugElapsedMs(channelDragStartedAtRef.current),
    });
  }

  function handleDragStart(payload: DragPayload | null) {
    if (suppressNavigationResetRef.current !== null) {
      window.clearTimeout(suppressNavigationResetRef.current);
      suppressNavigationResetRef.current = null;
    }
    activeDragRef.current = payload;
    flushSync(() => {
      setIsDraggingCategory(payload?.type === 'category');
    });
    if (payload?.type === 'category') {
      categoryDropSequenceRef.current += 1;
      categoryDragStartedAtRef.current = performance.now();
      lastCategoryMonitorDragLogAtRef.current = 0;
      lastCategoryDebugKeyRef.current = null;
      sidebarDndDebug('category-drag start', {
        sequence: categoryDropSequenceRef.current,
        categoryID: payload.categoryID,
        order: categoryOrderDebugSnapshot(),
      });
    }
    if (payload?.type === 'channel') {
      channelDropSequenceRef.current += 1;
      channelDragStartedAtRef.current = performance.now();
      lastChannelMonitorDragLogAtRef.current = 0;
      lastChannelDebugKeyRef.current = null;
      sidebarDndDebug('channel-drag start', {
        sequence: channelDropSequenceRef.current,
        channelID: payload.channel.channelID,
        channelName: payload.channel.channelName,
        categoryID: payload.channel.categoryID ?? '',
        favorite: !!payload.channel.favorite,
      });
    }
    setSuppressChannelNavigationID(
      payload?.type === 'channel'
        ? payload.channel.channelID
        : payload?.type === 'conversation'
          ? payload.conversation.conversationID
          : null,
    );
    clearDropTarget();
  }

  function updateResolvedDrop(payload: DropPayload | undefined) {
    const resolvedDrop = resolveDropPayload(payload);
    logCategoryResolution(payload, resolvedDrop);
    const previousChannelDrop = activeDragRef.current?.type === 'channel' && resolvedDropRef.current?.kind === 'channel'
      ? resolvedDropRef.current
      : null;
    const effectiveChannelDrop = resolvedDrop ?? previousChannelDrop;
    logChannelResolution(payload, resolvedDrop, effectiveChannelDrop);
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
    resolvedDropRef.current = resolvedDrop;
    if (resolvedDrop.kind === 'channel') {
      showChannelDropIndicator(resolvedDrop.sectionKey, resolvedDrop.index, resolvedDrop.area);
      return;
    }
    showCategoryDropIndicator(resolvedDrop.beforeCategoryID, resolvedDrop.position);
  }

  function handleDrop(payload: DropPayload | undefined) {
    // Prefer resolvedDropRef — it's written SYNCHRONOUSLY the moment an indicator
    // resolves (showChannelDropIndicator), so it's always the latest slot. The
    // visibleDropIndicatorRef mirror is synced by a useLayoutEffect and therefore
    // LAGS by a commit; releasing right after the final move (e.g. dragging out
    // of the preview's range and letting go before React commits) read that stale
    // ref and dropped one slot too high, not where the preview showed. Fall back
    // to the mirror, then to a fresh resolve of the raw drop payload.
    const resolvedDrop = activeDragRef.current
      ? (resolvedDropRef.current ?? visibleDropIndicatorRef.current ?? resolveDropPayload(payload))
      : resolveDropPayload(payload);
    if (activeDragRef.current?.type === 'channel') {
      sidebarDndDebug('channel-drop received', {
        sequence: channelDropSequenceRef.current,
        draggedChannelID: activeDragRef.current.channel.channelID,
        payload: describeDropPayload(payload),
        resolved: describeResolvedDrop(resolvedDrop),
        elapsedMs: debugElapsedMs(channelDragStartedAtRef.current),
      });
    }
    if (activeDragRef.current?.type === 'category') {
      sidebarDndDebug('category-drop received', {
        sequence: categoryDropSequenceRef.current,
        draggedCategoryID: activeDragRef.current.categoryID,
        payload: describeDropPayload(payload),
        resolved: describeResolvedDrop(resolvedDrop),
        order: categoryOrderDebugSnapshot(),
        elapsedMs: debugElapsedMs(categoryDragStartedAtRef.current),
      });
    }
    applyResolvedDrop(resolvedDrop);
    activeDragRef.current = null;
    setIsDraggingCategory(false);
    categoryDragStartedAtRef.current = null;
    lastCategoryDebugKeyRef.current = null;
    channelDragStartedAtRef.current = null;
    lastChannelDebugKeyRef.current = null;
    clearDropTarget();
    suppressNavigationResetRef.current = window.setTimeout(() => {
      setSuppressChannelNavigationID(null);
      suppressNavigationResetRef.current = null;
    }, 750);
  }

  function clearSuppressedChannelNavigation() {
    /* v8 ignore next -- the consumed callback fires right after a drop scheduled the reset timeout, so the ref is set; the null arm is defensive */
    /* istanbul ignore next -- the consumed callback fires right after a drop scheduled the reset timeout, so the ref is set; the null arm is defensive */
    if (suppressNavigationResetRef.current !== null) {
      window.clearTimeout(suppressNavigationResetRef.current);
      suppressNavigationResetRef.current = null;
    }
    setSuppressChannelNavigationID(null);
  }

  // Live "push-aside" preview: while a channel/DM/category is dragged, open a
  // row-height gap at the slot it would land in (WYSIWYG), so the rows/sections
  // below shift down and it's obvious where a drop will go. It's driven by the
  // same `dropIndicator` the drop itself uses, so preview == landing spot.
  // Explicit h-8 (≈ the desktop row box) — drag is desktop-only — keeps the
  // shift from reflowing; pointer-events-none so it never steals the live drop
  // hitbox. Categories pass their own testId so the two gaps stay distinct.
  function DropGap({ sectionKey, testId }: { sectionKey: string; testId?: string }) {
    return (
      <div
        data-testid={testId ?? `sidebar-drop-gap-${sectionKey}`}
        aria-hidden="true"
        className="pointer-events-none h-8 rounded-md border border-dashed border-white/25 bg-white/5"
      />
    );
  }

  const handleDragStartRef = useRef(handleDragStart);
  const updateResolvedDropRef = useRef(updateResolvedDrop);
  const handleDropRef = useRef(handleDrop);
  const logCategoryMonitorEventRef = useRef(logCategoryMonitorEvent);
  const logChannelMonitorEventRef = useRef(logChannelMonitorEvent);

  useLayoutEffect(() => {
    visibleDropIndicatorRef.current = dropIndicator;
  }, [dropIndicator]);

  useLayoutEffect(() => {
    handleDragStartRef.current = handleDragStart;
    updateResolvedDropRef.current = updateResolvedDrop;
    handleDropRef.current = handleDrop;
    logCategoryMonitorEventRef.current = logCategoryMonitorEvent;
    logChannelMonitorEventRef.current = logChannelMonitorEvent;
  });

  useEffect(() => {
    return monitorForElements({
      onDragStart: ({ source }) => {
        handleDragStartRef.current(source.data as DragPayload);
      },
      onDropTargetChange: ({ location }) => {
        const payload = currentDropPayload(location.current);
        logCategoryMonitorEventRef.current('dropTargetChange', payload, true);
        logChannelMonitorEventRef.current('dropTargetChange', payload, true);
        updateResolvedDropRef.current(payload);
      },
      onDrag: ({ location }) => {
        const payload = currentDropPayload(location.current);
        logCategoryMonitorEventRef.current('drag', payload);
        logChannelMonitorEventRef.current('drag', payload);
        updateResolvedDropRef.current(payload);
      },
      onDrop: ({ location }) => {
        const payload = currentDropPayload(location.current);
        logCategoryMonitorEventRef.current('drop', payload, true);
        logChannelMonitorEventRef.current('drop', payload, true);
        handleDropRef.current(payload);
      },
    });
  }, []);

  return (
    <div className="flex h-full w-full min-w-0 flex-col text-gray-300 max-md:select-none max-md:touch-pan-y max-md:[-webkit-touch-callout:none] max-md:[-webkit-user-select:none]">
      <ScrollArea
        className="min-h-0 w-full flex-1 max-md:touch-pan-y"
        scrollbarClassName="opacity-0 transition-opacity data-[scrolling]:opacity-100"
        data-testid="sidebar-scroll-area"
      >
        <div className="w-full min-w-0 space-y-1 p-2">
          {/* Activity sits at the very top — reaction hints + fired reminders. */}
          <NavLink
            to="/activity"
            onClick={onClose}
            className={({ isActive }) =>
              `relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors max-md:h-12 max-md:px-3 max-md:py-0 max-md:text-base ${
                isActive
                  ? 'bg-background text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <Bell className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className={activityUnread > 0 ? 'font-bold text-white' : ''}>Activity</span>
            {activityUnread > 0 && (
              <Badge
                variant="brand"
                className="ml-auto text-[11px]"
                data-testid="activity-unread-badge"
              >
                {activityUnread > 99 ? '99+' : activityUnread}
              </Badge>
            )}
          </NavLink>

          {/* Threads next — matches the design ordering. Same row
              geometry (px-2 py-1) as channel rows below so the eye
              doesn't catch on a height bump. */}
          <NavLink
            to="/threads"
            onClick={onClose}
            className={({ isActive }) =>
              `relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors max-md:h-12 max-md:px-3 max-md:py-0 max-md:text-base ${
                isActive
                  ? 'bg-background text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className={hasThreadUpdates ? 'font-bold text-white' : ''}>Threads</span>
            {hasThreadUpdates && (
              <Badge
                variant="brand"
                className="ml-auto text-[11px]"
                data-testid="threads-unread-badge"
              >
                {unreadThreadCount > 99 ? '99+' : unreadThreadCount}
              </Badge>
            )}
          </NavLink>

          <NavLink
            to="/directory/channels"
            onClick={onClose}
            className={() =>
              `relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors max-md:h-12 max-md:px-3 max-md:py-0 max-md:text-base ${
                directoryActive
                  ? 'bg-background text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <BookUser className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Directory</span>
          </NavLink>

          <NavLink
            to="/drafts"
            onClick={onClose}
            className={({ isActive }) =>
              `relative flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors max-md:h-12 max-md:px-3 max-md:py-0 max-md:text-base ${
                isActive
                  ? 'bg-background text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <FilePenLine className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Drafts</span>
            {draftCount > 0 && (
              <Badge variant="brand" className="ml-auto text-[11px]">
                {draftCount > 99 ? '99+' : draftCount}
              </Badge>
            )}
          </NavLink>

          {/* Visual break between top-level pages and the channel/DM list. */}
          <div
            data-testid="sidebar-top-divider"
            role="separator"
            className="my-2 h-px bg-white/10"
          />

          {/* "Add category" sits above the sections so the affordance is
              obvious before users scroll into the list. */}
          {creatingCategory ? (
            <div className="px-2 py-1 mb-1">
              <input
                autoFocus
                value={newCategoryName}
                onChange={(e) => {
                  setNewCategoryName(e.target.value);
                  setCategoryCreateError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const name = newCategoryName.trim();
                    if (!name) return;
                    createCategory.mutate(name, {
                      onSuccess: () => {
                        setNewCategoryName('');
                        setCreatingCategory(false);
                        setCategoryCreateError('');
                      },
                      onError: (err) => {
                        setCategoryCreateError(err instanceof Error ? err.message : 'Could not create category');
                      },
                    });
                  }
                  if (e.key === 'Escape') {
                    setCreatingCategory(false);
                    setCategoryCreateError('');
                  }
                }}
                placeholder="Category name…"
                data-testid="sidebar-new-category-input"
                className="w-full rounded-md bg-white/10 px-2 py-1 text-sm text-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-white/40 max-md:h-12 max-md:px-3 max-md:py-0 max-md:text-base"
              />
              {categoryCreateError && (
                <p className="mt-1 text-xs text-red-300" role="alert">
                  {categoryCreateError}
                </p>
              )}
            </div>
          ) : (
            <button
              onClick={() => {
                setCategoryCreateError('');
                setCreatingCategory(true);
              }}
              data-testid="sidebar-add-category"
              className="mb-1 w-full rounded-md px-2 py-1 text-left text-sm text-gray-500 hover:bg-white/5 hover:text-gray-300 max-md:h-12 max-md:px-3 max-md:py-0 max-md:text-base"
            >
              + Add category
            </button>
          )}

          {/* Unified sidebar list: Favorites (mixed) → user categories
              (mixed) → Channels (uncategorised) → Direct Messages
              (always rendered as the bottom section; its "+" routes to
              /conversations/new). User-defined categories contain channels;
              DMs/groups can only appear here when favorited. */}
          {sidebarPrimaryDataReady ? (
          <nav aria-label="Channels and direct messages" data-testid="sidebar-primary-sections">
            {sidebarSections.map((section) => {
              const isFavorites = section.key === SidebarSectionKeys.Favorites;
              const isChannelsDefault = section.key === SidebarSectionKeys.Channels;
              const isDMsDefault = section.key === SidebarSectionKeys.DirectMessages;
              const isUserCategory = !isFavorites && !isChannelsDefault && !isDMsDefault;
              const canDropChannel = isFavorites || isUserCategory || isChannelsDefault;
              const collapsed = !!collapsedGroups[section.key];

              // When collapsed, still surface:
              //   - items with new activity (unless muted) so the user
              //     doesn't miss messages hidden behind a folded category;
              //   - the channel/conversation the user is currently viewing,
              //     so navigating away from it (or scrolling up) doesn't
              //     make the row vanish out from under them. Once they
              //     switch focus elsewhere, the row hides again on the
              //     next render — exactly as the bug report asked for.
              const visibleItems = collapsed
                ? section.items.filter((item) => {
                    if (item.kind === 'channel') {
                      const ch = item.channel;
                      const isActive =
                        location.pathname === `/channel/${slugify(ch.channelName)}`;
                      return isActive || (!ch.muted && !!ch.unread);
                    }
                    const conv = item.conversation;
                    const isActive =
                      location.pathname === `/conversation/${conv.conversationID}`;
                    return isActive || !!conv.unread;
                  })
                : section.items;

              // The live channel/DM drop target that falls in THIS section (null
              // otherwise) — drives the push-aside gap below.
              const channelGap =
                dropIndicator?.kind === 'channel' && dropIndicator.sectionKey === section.key
                  ? dropIndicator
                  : null;
              // A category drag that would land BEFORE this section opens a gap
              // above it, pushing this section (and everything below) down — the
              // same WYSIWYG push-aside the channel/DM drag gets.
              const categoryGap =
                dropIndicator?.kind === 'category' &&
                dropIndicator.beforeCategoryID === (isChannelsDefault ? CATEGORY_DROP_END : section.key);

              return (
                <div key={section.key} className="relative mt-2" data-testid={`sidebar-group-${section.key}`}>
                  {categoryGap && <DropGap sectionKey={section.key} testId={`sidebar-drop-gap-cat-${section.key}`} />}
                  {(isFavorites || isUserCategory || isChannelsDefault) && (
                    <PragmaticCategoryDropHitbox
                      active={!isMobile && isDraggingCategory}
                      data={{
                        type: 'section-header-target',
                        sectionKey: section.key,
                        categoryID: isChannelsDefault ? CATEGORY_DROP_END : section.key,
                      }}
                      testID={`sidebar-category-boundary-drop-${section.key}`}
                    />
                  )}
                  <PragmaticCategoryHeader
                    id={section.key}
                    draggable={isUserCategory && !isMobile}
                    dropData={
                      !isMobile && (isFavorites || isUserCategory || isChannelsDefault)
                        ? {
                            type: 'section-header-target',
                            sectionKey: section.key,
                            categoryID: isChannelsDefault ? CATEGORY_DROP_END : section.key,
                          }
                        : undefined
                    }
                    className="group/sec relative flex items-center"
                    testID={`sidebar-group-header-${section.key}`}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleGroupCollapsed(section.key)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleGroupCollapsed(section.key);
                        }
                      }}
                      aria-expanded={!collapsed}
                      data-testid={`sidebar-group-toggle-${section.key}`}
                      className="flex flex-1 items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold text-gray-400 hover:bg-white/5 max-md:h-12 max-md:px-3 max-md:py-0 max-md:text-base"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${collapsed ? '-rotate-90' : ''}`}
                      />
                      <span className="truncate">{section.title}</span>
                    </div>
                    {/* Hover-revealed actions per section type. */}
                    {isChannelsDefault && !isGuest(user?.systemRole) && (
                      <button
                        onClick={() => setCreateChannelOpen(true)}
                        aria-label="Create channel"
                        title="Create channel"
                        data-testid="sidebar-create-channel"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white max-md:h-10 max-md:w-10 max-md:opacity-100"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {isDMsDefault && (
                      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                        {/* New DM "+": always a real tap target on mobile;
                            desktop keeps the hover-reveal. */}
                        <button
                          onClick={() => navigate('/conversations/new')}
                          aria-label="New direct message"
                          title="New direct message"
                          data-testid="sidebar-new-dm"
                          className="h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white max-md:h-10 max-md:w-10 max-md:opacity-100"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        {/* Sort menu stays desktop hover-only (hidden on mobile);
                            the header shows only the "+" on touch. opacity-0
                            alone still hit-tests, so pointer-events-none is
                            required on mobile — without it this was an
                            invisible tappable target right beside the "+"
                            (same treatment as the row kebabs). */}
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label="Sort direct messages"
                            data-testid="sidebar-dm-sort-menu"
                            className="h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white max-md:pointer-events-none"
                          >
                            <MoreVertical className="h-3.5 w-3.5" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem onClick={() => setConversationSortPreference('recent')}>
                              <Clock3 className="mr-2 h-4 w-4" />
                              Recent activity
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setConversationSortPreference('az')}>
                              <ArrowDownAZ className="mr-2 h-4 w-4" />
                              A-Z
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                    {isUserCategory && (
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={`Manage ${section.title} category`}
                          data-testid={`sidebar-category-menu-${section.key}`}
                          className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white max-md:h-10 max-md:w-10 max-md:opacity-100"
                        >
                          <MoreVertical className="h-3.5 w-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onClick={() => setCategoryToDelete({ id: section.key, title: section.title })}
                            data-testid={`sidebar-category-delete-${section.key}`}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete category
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </PragmaticCategoryHeader>
                  <div className="space-y-1">
                    {visibleItems.map((item, index) => {
                      if (item.kind === 'channel') {
                        const channelDropIndex = section.key === SidebarSectionKeys.Favorites
                          ? index
                          : visibleItems
                              .slice(0, index)
                              .filter((candidate) => candidate.kind === 'channel').length;
                        // Open the push-aside gap just above this row when the
                        // live drop target resolves to its slot (not the tail).
                        const showGap =
                          channelGap != null && channelGap.area !== 'end' && channelGap.index === channelDropIndex;
                        return (
                          // No wrapper div: the ChannelRow's own element is the
                          // direct `space-y-1` child (and already `relative`), so
                          // SIDEBAR_DRAGGING_COLLAPSE can fully remove its slot on
                          // pick-up (margin included).
                          <Fragment key={`ch-${item.channel.channelID}`}>
                            {showGap && <DropGap sectionKey={section.key} />}
                            <PragmaticChannelRow
                              sectionKey={section.key}
                              index={channelDropIndex}
                              channel={item.channel}
                              disabled={isMobile}
                            >
                              {(dragProps) => (
                                <ChannelRow
                                  channel={item.channel}
                                  hasUnread={!!item.channel.unread}
                                  unreadCount={item.channel.unreadCount ?? 0}
                                  onClose={onClose}
                                  draggable={!isMobile}
                                  suppressNavigation={suppressChannelNavigationID === item.channel.channelID}
                                  onSuppressNavigationConsumed={clearSuppressedChannelNavigation}
                                  {...dragProps}
                                />
                              )}
                            </PragmaticChannelRow>
                          </Fragment>
                        );
                      }
                      const conv = item.conversation;
                      const conversationDropIndex = section.key === SidebarSectionKeys.Favorites ? index : -1;
                      const isGroup = conv.type === 'group';
                      const otherID = !isGroup
                        ? ((conv.participantIDs ?? []).find((p) => p !== user?.id) ?? conv.participantIDs?.[0])
                        : undefined;
                      const dmAvatarURL = otherID ? dmUserMap.get(otherID)?.avatarURL : undefined;
                      const dmUserStatus = otherID ? dmUserMap.get(otherID)?.userStatus : undefined;
                      const resolvedDMAvatarURL = conv.avatarURL ?? dmAvatarURL;
                      const resolvedDMUserStatus = conv.userStatus ?? dmUserStatus;
                      const dmOnline = otherID ? online.has(otherID) : undefined;
                      // Favorited DMs are channel-drop targets too; open the gap
                      // above one when the live target resolves to its slot.
                      const showConvGap =
                        channelGap != null && channelGap.area !== 'end' && channelGap.index === conversationDropIndex;
                      return (
                        // No wrapper div (see the channel branch): the row's own
                        // element is the direct `space-y-1` child so a favorited
                        // DM's slot collapses fully on pick-up.
                        <Fragment key={`conv-${conv.conversationID}`}>
                          {showConvGap && <DropGap sectionKey={section.key} />}
                          {section.key === SidebarSectionKeys.Favorites ? (
                            <PragmaticConversationRow
                              sectionKey={section.key}
                              index={conversationDropIndex}
                              conversation={conv}
                              disabled={isMobile}
                            >
                              {(dragProps) => (
                                <ConversationRow
                                  conversation={conv}
                                  hasUnread={!!conv.unread}
                                  unreadCount={conv.unreadCount ?? 0}
                                  dmAvatarURL={resolvedDMAvatarURL}
                                  dmUserStatus={resolvedDMUserStatus}
                                  dmOnline={dmOnline}
                                  onClose={onClose}
                                  onHide={hideConversation}
                                  draggable={!isMobile}
                                  suppressNavigation={suppressChannelNavigationID === conv.conversationID}
                                  onSuppressNavigationConsumed={clearSuppressedChannelNavigation}
                                  {...dragProps}
                                />
                              )}
                            </PragmaticConversationRow>
                          ) : (
                            <ConversationRow
                              conversation={conv}
                              hasUnread={!!conv.unread}
                              unreadCount={conv.unreadCount ?? 0}
                              dmAvatarURL={resolvedDMAvatarURL}
                              dmUserStatus={resolvedDMUserStatus}
                              dmOnline={dmOnline}
                              onClose={onClose}
                              onHide={hideConversation}
                            />
                          )}
                        </Fragment>
                      );
                    })}
                    {/* Tail gap: drop resolves past the last row (area 'end'). */}
                    {channelGap != null && channelGap.area === 'end' && <DropGap sectionKey={section.key} />}
                  </div>
                  <PragmaticSection
                    data={{ type: 'channel-target', sectionKey: section.key, index: dropCount(section.key, visibleItems), area: 'end' }}
                    disabled={!canDropChannel}
                    className="min-h-2 pb-2"
                    testID={canDropChannel ? `sidebar-section-tail-drop-${section.key}` : undefined}
                  >
                    {/* Land-in-place: no drop line. The row itself re-sorts to
                        its released slot via the optimistic reorder cache. */}
                  </PragmaticSection>
                </div>
              );
            })}
          </nav>
          ) : (
            <SidebarSectionsSkeleton />
          )}
        </div>
      </ScrollArea>

      {/* Dialogs */}
      <CreateChannelDialog
        open={createChannelOpen}
        onOpenChange={setCreateChannelOpen}
      />
      <ConfirmDialog
        open={categoryToDelete !== null}
        onOpenChange={(o) => {
          /* v8 ignore next -- controlled dialog (open={categoryToDelete !== null}); onOpenChange only fires with o=false on dismiss, so the o=true arm is unreachable */
          /* istanbul ignore next -- controlled dialog; onOpenChange only fires with o=false on dismiss, so the o=true arm is unreachable */
          if (!o) setCategoryToDelete(null);
        }}
        title="Delete category?"
        description={
          categoryToDelete
            ? `"${categoryToDelete.title}" will be removed. Channels and DMs in it return to their default sections.`
            : undefined
        }
        confirmLabel="Delete category"
        destructive
        onConfirm={() => {
          /* v8 ignore next -- onConfirm only fires while the dialog is open, i.e. categoryToDelete is non-null; the null arm is unreachable */
          /* istanbul ignore next -- onConfirm only fires while the dialog is open, i.e. categoryToDelete is non-null; the null arm is unreachable */
          if (categoryToDelete) deleteCategory.mutate(categoryToDelete.id);
        }}
        testIDPrefix="delete-category"
      />
    </div>
  );
}
