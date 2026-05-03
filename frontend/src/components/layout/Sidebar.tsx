import { useCallback, useEffect, useLayoutEffect, useState, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
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
  LogOut,
  BookUser,
  UserPlus,
  User as UserIcon,
  Smile,
  Settings,
  Info,
  MessagesSquare,
  MoreVertical,
  Trash2,
  ArrowDownAZ,
  Clock3,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { isAdmin, isGuest } from '@/lib/roles';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useUserThreads, hasUnreadActivity } from '@/hooks/useThreads';
import { useCategories, useCreateCategory, useDeleteCategory, useFavoriteChannel, useSetCategory, useSetConversationCategory, useReorderCategories } from '@/hooks/useSidebar';
import { groupSidebarItems, SidebarSectionKeys, type SidebarItem, type ConversationSidebarSort } from '@/lib/sidebar-groups';
import type { SidebarCategory, UserChannel, UserConversation } from '@/types';
import { ChannelRow } from './ChannelRow';
import { ConversationRow } from './ConversationRow';
import { CreateChannelDialog } from '@/components/channels/CreateChannelDialog';
import { InviteDialog } from '@/components/InviteDialog';
import { EditProfileDialog } from '@/components/EditProfileDialog';
import { AboutDialog } from '@/components/AboutDialog';
import { EmojiManagerDialog } from '@/components/EmojiManagerDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

interface SidebarProps {
  onClose: () => void;
}

const SIDEBAR_POSITION_STEP = 1000;
const CONVERSATION_SORT_STORAGE_KEY = 'sidebar.conversationSort';
const CATEGORY_DROP_END = '__category-end__';
const SIDEBAR_DND_DEBUG_STORAGE_KEY = 'ex.sidebarDndDebug';
const SIDEBAR_DRAGGING_OPACITY = 0.25;
const SIDEBAR_DROP_LINE_CLASS = 'pointer-events-none absolute left-2 right-2 top-0 z-10 h-px bg-white/85';

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
  console.debug(`[sidebar-dnd] ${event}`, details ?? {});
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
          getData: ({ input, element }) => {
            const currentDropData = dropDataRef.current;
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
    if (!element) return undefined;
    return dropTargetForElements({
      element,
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
  children,
}: {
  sectionKey: string;
  index: number;
  channel: UserChannel;
  children: (args: {
    dragRef?: (node: HTMLElement | null) => void;
    dragStyle?: CSSProperties;
  }) => ReactNode;
}) {
  const elementRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
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
  }, [channel, index, sectionKey]);

  const setElementRef = useCallback((node: HTMLElement | null) => {
    elementRef.current = node;
  }, []);

  return (
    <>
      {/* eslint-disable-next-line react-hooks/refs -- passing ref callbacks to a child render prop; refs are only assigned by React later. */}
      {children({
        dragRef: setElementRef,
        dragStyle: { opacity: dragging ? SIDEBAR_DRAGGING_OPACITY : undefined },
      })}
    </>
  );
}

function PragmaticConversationRow({
  sectionKey,
  index,
  conversation,
  children,
}: {
  sectionKey: string;
  index: number;
  conversation: UserConversation;
  children: (args: {
    dragRef?: (node: HTMLElement | null) => void;
    dragStyle?: CSSProperties;
  }) => ReactNode;
}) {
  const elementRef = useRef<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
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
  }, [conversation, index, sectionKey]);

  const setElementRef = useCallback((node: HTMLElement | null) => {
    elementRef.current = node;
  }, []);

  return (
    <>
      {/* eslint-disable-next-line react-hooks/refs -- passing ref callbacks to a child render prop; refs are only assigned by React later. */}
      {children({
        dragRef: setElementRef,
        dragStyle: { opacity: dragging ? SIDEBAR_DRAGGING_OPACITY : undefined },
      })}
    </>
  );
}

export function Sidebar({ onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const { unreadChannels, unreadConversations, hiddenConversations, hideConversation } = useUnread();
  const { data: channels } = useUserChannels();
  const { data: conversations } = useUserConversations();
  const { data: threads } = useUserThreads();
  const { data: categories } = useCategories();
  const createCategory = useCreateCategory();
  const deleteCategory = useDeleteCategory();
  const favoriteChannel = useFavoriteChannel();
  const setCategory = useSetCategory();
  const setConversationCategory = useSetConversationCategory();
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
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [emojiManagerOpen, setEmojiManagerOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const userMenuTriggerRef = useRef<HTMLButtonElement>(null);
  // null = closed; otherwise the section being deleted. Modal confirm
  // replaces window.confirm so the prompt fits the rest of the app's
  // visual language (and is mockable in tests).
  const [categoryToDelete, setCategoryToDelete] = useState<{ id: string; title: string } | null>(null);

  const visibleConversations = useMemo(
    () => conversations?.filter((c) => !hiddenConversations.has(c.conversationID)) ?? [],
    [conversations, hiddenConversations],
  );
  const hasThreadUpdates = (threads ?? []).some((t) => hasUnreadActivity(t));

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
    for (const c of visibleConversations ?? []) {
      if (c.type !== 'dm') continue;
      const other = (c.participantIDs ?? []).find((p) => p !== user?.id) ?? c.participantIDs?.[0];
      if (other && !seen.has(other)) {
        seen.add(other);
        ids.push(other);
      }
    }
    return ids;
  }, [visibleConversations, user?.id]);
  const { map: dmUserMap } = useUsersBatch(dmOtherUserIDs);

  const initials = user?.displayName
    ?.split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2) ?? '??';

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  function clearUserMenuFocus() {
    userMenuTriggerRef.current?.blur();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function scheduleClearUserMenuFocus() {
    clearUserMenuFocus();
    queueMicrotask(clearUserMenuFocus);
    requestAnimationFrame(() => {
      clearUserMenuFocus();
      requestAnimationFrame(clearUserMenuFocus);
    });
    window.setTimeout(clearUserMenuFocus, 50);
  }

  function setAboutOpenAndClearUserFocus(open: boolean) {
    setAboutOpen(open);
    scheduleClearUserMenuFocus();
  }

  function setConversationSortPreference(sort: ConversationSidebarSort) {
    setConversationSort(sort);
    localStorage.setItem(CONVERSATION_SORT_STORAGE_KEY, sort);
  }

  function sectionCategoryID(sectionKey: string): string {
    return sectionKey === SidebarSectionKeys.Channels ? '' : sectionKey;
  }

  function positionForDrop(items: SidebarItem[], targetIndex: number): number {
    const currentDraggedChannel = activeDragRef.current?.type === 'channel' ? activeDragRef.current.channel : null;
    const channelsOnly = items
      .filter((item): item is Extract<SidebarItem, { kind: 'channel' }> => item.kind === 'channel')
      .map((item) => item.channel);
    const draggedIndex = channelsOnly.findIndex((channel) => channel.channelID === currentDraggedChannel?.channelID);
    const adjustedTargetIndex = draggedIndex >= 0 && draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
    const orderedChannels = channelsOnly.filter((channel) => channel.channelID !== currentDraggedChannel?.channelID);
    const before = orderedChannels[adjustedTargetIndex - 1]?.sidebarPosition;
    const after = orderedChannels[adjustedTargetIndex]?.sidebarPosition;

    if (before && after && after - before > 1) return Math.floor((before + after) / 2);
    if (before) return before + SIDEBAR_POSITION_STEP;
    if (after && after > 1) return Math.floor(after / 2);
    if (after !== undefined) return after - SIDEBAR_POSITION_STEP;
    return SIDEBAR_POSITION_STEP;
  }

  function currentDraggedItemID(): string | null {
    const drag = activeDragRef.current;
    if (drag?.type === 'channel') return drag.channel.channelID;
    if (drag?.type === 'conversation') return drag.conversation.conversationID;
    return null;
  }

  function sidebarItemID(item: SidebarItem): string {
    return item.kind === 'channel'
      ? item.channel.channelID
      : item.conversation.conversationID;
  }

  function sidebarItemPosition(item: SidebarItem | undefined): number | undefined {
    if (!item) return undefined;
    return item.kind === 'channel'
      ? item.channel.sidebarPosition
      : item.conversation.sidebarPosition;
  }

  function positionForSidebarItemDrop(items: SidebarItem[], targetIndex: number): number {
    const draggedID = currentDraggedItemID();
    const draggedIndex = items.findIndex((item) => sidebarItemID(item) === draggedID);
    const adjustedTargetIndex = draggedIndex >= 0 && draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;
    const orderedItems = items.filter((item) => sidebarItemID(item) !== draggedID);
    const before = sidebarItemPosition(orderedItems[adjustedTargetIndex - 1]);
    const after = sidebarItemPosition(orderedItems[adjustedTargetIndex]);

    if (before && after && after - before > 1) return Math.floor((before + after) / 2);
    if (before) return before + SIDEBAR_POSITION_STEP;
    if (after && after > 1) return Math.floor(after / 2);
    if (after !== undefined) return after - SIDEBAR_POSITION_STEP;
    return SIDEBAR_POSITION_STEP;
  }

  function dropChannelInto(sectionKey: string, items: SidebarItem[], targetIndex: number) {
    const currentDraggedChannel = activeDragRef.current?.type === 'channel' ? activeDragRef.current.channel : null;
    if (!currentDraggedChannel) {
      sidebarDndDebug('channel-drop ignored: no active channel', {
        sequence: channelDropSequenceRef.current,
        sectionKey,
        targetIndex,
        activeDrag: activeDragRef.current,
      });
      return;
    }
    if (sectionKey === SidebarSectionKeys.DirectMessages) {
      sidebarDndDebug('channel-drop ignored: direct messages section', {
        sequence: channelDropSequenceRef.current,
        channelID: currentDraggedChannel.channelID,
        sectionKey,
        targetIndex,
      });
      return;
    }
    if (sectionKey === SidebarSectionKeys.Favorites) {
      const sidebarPosition = positionForSidebarItemDrop(items, targetIndex);
      sidebarDndDebug('channel-favorite scheduled', {
        sequence: channelDropSequenceRef.current,
        channelID: currentDraggedChannel.channelID,
        favorite: true,
        targetIndex,
        sidebarPosition,
      });
      if (!currentDraggedChannel.favorite) {
        favoriteChannel.mutate({ channelID: currentDraggedChannel.channelID, favorite: true });
      }
      setCategory.mutate({
        channelID: currentDraggedChannel.channelID,
        categoryID: currentDraggedChannel.categoryID ?? '',
        sidebarPosition,
      });
      setDropIndicator(null);
      return;
    }
    if (currentDraggedChannel.favorite) {
      sidebarDndDebug('channel-favorite scheduled', {
        sequence: channelDropSequenceRef.current,
        channelID: currentDraggedChannel.channelID,
        favorite: false,
        targetIndex,
      });
      favoriteChannel.mutate({ channelID: currentDraggedChannel.channelID, favorite: false });
    }
    const sidebarPosition = positionForDrop(items, targetIndex);
    sidebarDndDebug('channel-mutation scheduled', {
      sequence: channelDropSequenceRef.current,
      channelID: currentDraggedChannel.channelID,
      sectionKey,
      categoryID: sectionCategoryID(sectionKey),
      targetIndex,
      sidebarPosition,
      order: channelOrderDebugSnapshot(sectionKey),
    });
    setCategory.mutate({
      channelID: currentDraggedChannel.channelID,
      categoryID: sectionCategoryID(sectionKey),
      sidebarPosition,
    });
    setDropIndicator(null);
  }

  function dropConversationInto(sectionKey: string, items: SidebarItem[], targetIndex: number) {
    const currentDraggedConversation = activeDragRef.current?.type === 'conversation' ? activeDragRef.current.conversation : null;
    if (!currentDraggedConversation) return;
    if (sectionKey !== SidebarSectionKeys.Favorites) return;
    const sidebarPosition = positionForSidebarItemDrop(items, targetIndex);
    sidebarDndDebug('conversation-mutation scheduled', {
      sequence: channelDropSequenceRef.current,
      conversationID: currentDraggedConversation.conversationID,
      sectionKey,
      targetIndex,
      sidebarPosition,
      order: channelOrderDebugSnapshot(sectionKey),
    });
    setConversationCategory.mutate({
      conversationID: currentDraggedConversation.conversationID,
      categoryID: currentDraggedConversation.categoryID ?? '',
      sidebarPosition,
    });
    setDropIndicator(null);
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
    return [...(categories ?? [])]
      .filter((category) => category.id !== (activeDragRef.current?.type === 'category' ? activeDragRef.current.categoryID : null))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  function categoryOrderDebugSnapshot(): Array<{ id: string; name: string; position: number }> {
    return [...(categories ?? [])]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
      .map((category) => ({ id: category.id, name: category.name, position: category.position }));
  }

  function channelOrderDebugSnapshot(sectionKey?: string) {
    return sidebarSections
      .filter((section) => sectionKey === undefined || section.key === sectionKey)
      .map((section) => ({
        sectionKey: section.key,
        title: section.title,
        channels: section.items
          .filter((item): item is Extract<SidebarItem, { kind: 'channel' }> => item.kind === 'channel')
          .map((item, index) => ({
            index,
            channelID: item.channel.channelID,
            name: item.channel.channelName,
            sidebarPosition: item.channel.sidebarPosition ?? null,
            favorite: !!item.channel.favorite,
          })),
      }));
  }

  function orderedCategoriesAfterDrop(draggedCategoryID: string, beforeCategoryID: string): SidebarCategory[] {
    const withoutDragged = sortedCategoriesWithoutDragged();
    const draggedCategory = categories?.find((category) => category.id === draggedCategoryID);
    if (!draggedCategory) return withoutDragged;
    const beforeIndex = beforeCategoryID === CATEGORY_DROP_END
      ? withoutDragged.length
      : withoutDragged.findIndex((category) => category.id === beforeCategoryID);
    const insertIndex = beforeIndex < 0 ? withoutDragged.length : beforeIndex;
    return [
      ...withoutDragged.slice(0, insertIndex),
      draggedCategory,
      ...withoutDragged.slice(insertIndex),
    ];
  }

  function normalizeCategoryDropSlot(beforeCategoryID: string, draggedCategoryID: string): string {
    return beforeCategoryID === draggedCategoryID ? nextCategoryTarget(draggedCategoryID) : beforeCategoryID;
  }

  function moveCategoryBefore(beforeCategoryID: string) {
    const draggedCategoryID = activeDragRef.current?.type === 'category' ? activeDragRef.current.categoryID : null;
    const sequence = categoryDropSequenceRef.current;
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
    if (!draggedCategory) {
      sidebarDndDebug('category-drop ignored: dragged category missing from cache', {
        sequence,
        draggedCategoryID,
        beforeCategoryID: normalizedBeforeCategoryID,
        order: categoryOrderDebugSnapshot(),
      });
      return;
    }

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

  function isChannelDropIndicator(sectionKey: string, index: number, area: ChannelDropArea): boolean {
    return dropIndicator?.kind === 'channel' && dropIndicator.sectionKey === sectionKey && dropIndicator.index === index && dropIndicator.area === area;
  }

  function applyResolvedDrop(drop: ResolvedDrop | null) {
    if (!drop) return;
    if (drop.kind === 'channel') {
      const section = sidebarSections.find((candidate) => candidate.key === drop.sectionKey);
      if (!section) return;
      if (activeDragRef.current?.type === 'channel') {
        dropChannelInto(drop.sectionKey, section.items, drop.index);
        return;
      }
      if (activeDragRef.current?.type === 'conversation') {
        dropConversationInto(drop.sectionKey, section.items, drop.index);
      }
      return;
    }
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
      if (canAcceptChannelDrop(section.key)) {
        return { kind: 'channel', sectionKey: section.key, index: channelCount(section.items), area: 'end' };
      }
    }
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
    if (!section) return 'row';
    return index >= dropCount(sectionKey, section.items) ? 'end' : 'row';
  }

  function resolveDropPayload(payload: DropPayload | undefined): ResolvedDrop | null {
    if (!payload) return null;
    const currentDrag = activeDragRef.current;
    if (payload.type === 'channel-target') {
      const edge = extractClosestEdge(payload);
      if (currentDrag?.type === 'category') {
        return null;
      }
      if (currentDrag?.type === 'conversation' && payload.sectionKey !== SidebarSectionKeys.Favorites) return null;
      if (currentDrag?.type !== 'channel' && currentDrag?.type !== 'conversation') return null;
      const index = edge === 'bottom' ? payload.index + 1 : payload.index;
      const area = edge === 'bottom'
        ? channelDropAreaForIndex(payload.sectionKey, index)
        : payload.area;
      return { kind: 'channel', sectionKey: payload.sectionKey, index, area };
    }
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
      elapsedMs: categoryDragStartedAtRef.current === null
        ? null
        : Math.round(performance.now() - categoryDragStartedAtRef.current),
    });
  }

  function logCategoryMonitorEvent(event: string, payload: DropPayload | undefined, force = false) {
    if (activeDragRef.current?.type !== 'category') return;
    if (event === 'drag') return;
    const now = performance.now();
    if (!force && now - lastCategoryMonitorDragLogAtRef.current < 250) return;
    lastCategoryMonitorDragLogAtRef.current = now;
    sidebarDndDebug(`category-monitor ${event}`, {
      sequence: categoryDropSequenceRef.current,
      draggedCategoryID: activeDragRef.current.categoryID,
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDropRef.current),
      elapsedMs: categoryDragStartedAtRef.current === null
        ? null
        : Math.round(now - categoryDragStartedAtRef.current),
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
      elapsedMs: channelDragStartedAtRef.current === null
        ? null
        : Math.round(performance.now() - channelDragStartedAtRef.current),
    });
  }

  function logChannelMonitorEvent(event: string, payload: DropPayload | undefined, force = false) {
    if (activeDragRef.current?.type !== 'channel') return;
    if (event === 'drag') return;
    const now = performance.now();
    if (!force && now - lastChannelMonitorDragLogAtRef.current < 250) return;
    lastChannelMonitorDragLogAtRef.current = now;
    sidebarDndDebug(`channel-monitor ${event}`, {
      sequence: channelDropSequenceRef.current,
      draggedChannelID: activeDragRef.current.channel.channelID,
      payload: describeDropPayload(payload),
      resolved: describeResolvedDrop(resolvedDropRef.current),
      elapsedMs: channelDragStartedAtRef.current === null
        ? null
        : Math.round(now - channelDragStartedAtRef.current),
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
    const resolvedDrop = activeDragRef.current
      ? (visibleDropIndicatorRef.current ?? resolvedDropRef.current ?? resolveDropPayload(payload))
      : resolveDropPayload(payload);
    if (activeDragRef.current?.type === 'channel') {
      sidebarDndDebug('channel-drop received', {
        sequence: channelDropSequenceRef.current,
        draggedChannelID: activeDragRef.current.channel.channelID,
        payload: describeDropPayload(payload),
        resolved: describeResolvedDrop(resolvedDrop),
        elapsedMs: channelDragStartedAtRef.current === null
          ? null
          : Math.round(performance.now() - channelDragStartedAtRef.current),
      });
    }
    if (activeDragRef.current?.type === 'category') {
      sidebarDndDebug('category-drop received', {
        sequence: categoryDropSequenceRef.current,
        draggedCategoryID: activeDragRef.current.categoryID,
        payload: describeDropPayload(payload),
        resolved: describeResolvedDrop(resolvedDrop),
        order: categoryOrderDebugSnapshot(),
        elapsedMs: categoryDragStartedAtRef.current === null
          ? null
          : Math.round(performance.now() - categoryDragStartedAtRef.current),
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
    if (suppressNavigationResetRef.current !== null) {
      window.clearTimeout(suppressNavigationResetRef.current);
      suppressNavigationResetRef.current = null;
    }
    setSuppressChannelNavigationID(null);
  }

  function DropLine() {
    return (
      <div
        data-testid="sidebar-drop-indicator"
        className={SIDEBAR_DROP_LINE_CLASS}
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
    <div className="flex h-full flex-col text-gray-300">
      {/* User section */}
      <div className="flex items-center gap-2 border-b border-white/10 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger
              ref={userMenuTriggerRef}
              className="flex flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              aria-label="User menu"
            >
              <Avatar className="h-8 w-8">
                <AvatarImage src={user?.avatarURL} alt="" />
                <AvatarFallback className="bg-emerald-700 text-white text-xs">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <span className="flex-1 truncate text-sm font-semibold text-white">
                {user?.displayName}
              </span>
              {isAdmin(user?.systemRole) && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0 bg-white/20 text-white border-0">
                  Admin
                </Badge>
              )}
              <ChevronDown className="h-4 w-4 text-gray-400" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onClick={() => setEditProfileOpen(true)}>
              <UserIcon className="mr-2 h-4 w-4" />
              Edit profile
            </DropdownMenuItem>
            {isAdmin(user?.systemRole) && (
              <DropdownMenuItem onClick={() => setInviteOpen(true)}>
                <UserPlus className="mr-2 h-4 w-4" />
                Invite people
              </DropdownMenuItem>
            )}
            {!isGuest(user?.systemRole) && (
              <DropdownMenuItem onClick={() => setEmojiManagerOpen(true)}>
                <Smile className="mr-2 h-4 w-4" />
                Custom emojis
              </DropdownMenuItem>
            )}
            {isAdmin(user?.systemRole) && (
              <DropdownMenuItem
                onClick={() => {
                  onClose();
                  navigate('/admin');
                }}
                data-testid="user-menu-admin"
              >
                <Settings className="mr-2 h-4 w-4" />
                Admin
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                setAboutOpenAndClearUserFocus(true);
              }}
            >
              <Info className="mr-2 h-4 w-4" />
              About
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ScrollArea
        className="min-h-0 flex-1"
        scrollbarClassName="opacity-0 transition-opacity data-[scrolling]:opacity-100"
        data-testid="sidebar-scroll-area"
      >
        <div className="space-y-px p-2">
          {/* Directories link — same row geometry (px-2 py-1) as channel
              rows below so the eye doesn't catch on a height bump. */}
          <NavLink
            to="/directory"
            onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors ${
                isActive
                  ? 'bg-white/15 text-white font-semibold'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <BookUser className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Directory</span>
          </NavLink>

          <NavLink
            to="/threads"
            onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors ${
                isActive
                  ? 'bg-white/15 text-white font-semibold'
                  : 'text-gray-300 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className={hasThreadUpdates ? 'font-bold text-white' : ''}>Threads</span>
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
                className="w-full rounded-md bg-white/10 px-2 py-1 text-sm text-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-white/40"
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
              className="mb-1 w-full rounded-md px-2 py-1 text-left text-sm text-gray-500 hover:bg-white/5 hover:text-gray-300"
            >
              + Add category
            </button>
          )}

          {/* Unified sidebar list: Favorites (mixed) → user categories
              (mixed) → Channels (uncategorised) → Direct Messages
              (always rendered as the bottom section; its "+" routes to
              /conversations/new). Both channels and DMs/groups can live
              in any user-defined category. */}
          <nav aria-label="Channels and direct messages">
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
                      return isActive || (!ch.muted && unreadChannels.has(ch.channelID));
                    }
                    const conv = item.conversation;
                    const isActive =
                      location.pathname === `/conversation/${conv.conversationID}`;
                    return isActive || unreadConversations.has(conv.conversationID);
                  })
                : section.items;

              return (
                <div key={section.key} className="relative mt-2" data-testid={`sidebar-group-${section.key}`}>
                  {(isFavorites || isUserCategory || isChannelsDefault) && (
                    <PragmaticCategoryDropHitbox
                      active={isDraggingCategory}
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
                    draggable={isUserCategory}
                    dropData={
                      isFavorites || isUserCategory || isChannelsDefault
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
                    {dropIndicator?.kind === 'category' &&
                      dropIndicator.beforeCategoryID === (isChannelsDefault ? CATEGORY_DROP_END : section.key) && (
                        <DropLine />
                      )}
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
                      className="flex flex-1 items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold text-gray-400 hover:bg-white/5"
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
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {isDMsDefault && (
                      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-hover/sec:opacity-100">
                        <button
                          onClick={() => navigate('/conversations/new')}
                          aria-label="New direct message"
                          title="New direct message"
                          data-testid="sidebar-new-dm"
                          className="h-5 w-5 flex items-center justify-center rounded text-gray-400 hover:bg-white/20 hover:text-white"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label="Sort direct messages"
                            data-testid="sidebar-dm-sort-menu"
                            className="h-5 w-5 flex items-center justify-center rounded text-gray-400 hover:bg-white/20 hover:text-white"
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
                          className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white"
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
                  {isChannelDropIndicator(section.key, 0, 'lead') && (
                    <div className="relative h-0">
                      <DropLine />
                    </div>
                  )}
                  <div className="space-y-px">
                    {visibleItems.map((item, index) => {
                      if (item.kind === 'channel') {
                        const channelDropIndex = section.key === SidebarSectionKeys.Favorites
                          ? index
                          : visibleItems
                              .slice(0, index)
                              .filter((candidate) => candidate.kind === 'channel').length;
                        return (
                          <div
                            key={`ch-${item.channel.channelID}`}
                            className="relative"
                          >
                            {isChannelDropIndicator(section.key, channelDropIndex, 'row') && <DropLine />}
                            <PragmaticChannelRow
                              sectionKey={section.key}
                              index={channelDropIndex}
                              channel={item.channel}
                            >
                              {(dragProps) => (
                                <ChannelRow
                                  channel={item.channel}
                                  hasUnread={unreadChannels.has(item.channel.channelID)}
                                  onClose={onClose}
                                  draggable
                                  suppressNavigation={suppressChannelNavigationID === item.channel.channelID}
                                  onSuppressNavigationConsumed={clearSuppressedChannelNavigation}
                                  {...dragProps}
                                />
                              )}
                            </PragmaticChannelRow>
                          </div>
                        );
                      }
                      const conv = item.conversation;
                      const conversationDropIndex = section.key === SidebarSectionKeys.Favorites ? index : -1;
                      const isGroup = conv.type === 'group';
                      const otherID = !isGroup
                        ? ((conv.participantIDs ?? []).find((p) => p !== user?.id) ?? conv.participantIDs?.[0])
                        : undefined;
                      const dmAvatarURL = otherID ? dmUserMap.get(otherID)?.avatarURL : undefined;
                      return (
                        <div key={`conv-${conv.conversationID}`} className="relative">
                          {section.key === SidebarSectionKeys.Favorites &&
                            isChannelDropIndicator(section.key, conversationDropIndex, 'row') && <DropLine />}
                          {section.key === SidebarSectionKeys.Favorites ? (
                            <PragmaticConversationRow
                              sectionKey={section.key}
                              index={conversationDropIndex}
                              conversation={conv}
                            >
                              {(dragProps) => (
                                <ConversationRow
                                  conversation={conv}
                                  hasUnread={unreadConversations.has(conv.conversationID)}
                                  dmAvatarURL={dmAvatarURL}
                                  onClose={onClose}
                                  onHide={hideConversation}
                                  draggable
                                  suppressNavigation={suppressChannelNavigationID === conv.conversationID}
                                  onSuppressNavigationConsumed={clearSuppressedChannelNavigation}
                                  {...dragProps}
                                />
                              )}
                            </PragmaticConversationRow>
                          ) : (
                            <ConversationRow
                              conversation={conv}
                              hasUnread={unreadConversations.has(conv.conversationID)}
                              dmAvatarURL={dmAvatarURL}
                              onClose={onClose}
                              onHide={hideConversation}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <PragmaticSection
                    data={{ type: 'channel-target', sectionKey: section.key, index: dropCount(section.key, visibleItems), area: 'end' }}
                    disabled={!canDropChannel}
                    className="min-h-2 pb-2"
                    testID={canDropChannel ? `sidebar-section-tail-drop-${section.key}` : undefined}
                  >
                    {isChannelDropIndicator(section.key, dropCount(section.key, visibleItems), 'end') && (
                      <div className="relative h-0">
                        <DropLine />
                      </div>
                    )}
                  </PragmaticSection>
                </div>
              );
            })}
          </nav>
        </div>
      </ScrollArea>

      {/* Dialogs */}
      <CreateChannelDialog
        open={createChannelOpen}
        onOpenChange={setCreateChannelOpen}
      />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <EditProfileDialog open={editProfileOpen} onOpenChange={setEditProfileOpen} />
      <EmojiManagerDialog open={emojiManagerOpen} onOpenChange={setEmojiManagerOpen} />
      <AboutDialog
        open={aboutOpen}
        onOpenChange={setAboutOpenAndClearUserFocus}
        onClosed={scheduleClearUserMenuFocus}
      />

      <ConfirmDialog
        open={categoryToDelete !== null}
        onOpenChange={(o) => {
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
          if (categoryToDelete) deleteCategory.mutate(categoryToDelete.id);
        }}
        testIDPrefix="delete-category"
      />
    </div>
  );
}
