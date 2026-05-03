import { useCallback, useEffect, useState, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
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
import { useCategories, useCreateCategory, useDeleteCategory, useFavoriteChannel, useSetCategory, useUpdateCategory } from '@/hooks/useSidebar';
import { groupSidebarItems, SidebarSectionKeys, type SidebarItem, type ConversationSidebarSort } from '@/lib/sidebar-groups';
import type { SidebarCategory, UserChannel } from '@/types';
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

type ChannelDropArea = 'lead' | 'row' | 'end';
type ResolvedDrop =
  | { kind: 'channel'; sectionKey: string; index: number; area: ChannelDropArea }
  | { kind: 'category'; categoryID: string };
type DropIndicator = ResolvedDrop;

type DragPayload =
  | { type: 'channel'; channel: UserChannel }
  | { type: 'category'; categoryID: string };

type DropPayload =
  | { type: 'channel-target'; sectionKey: string; index: number; area: ChannelDropArea }
  | { type: 'section-header-target'; sectionKey: string; categoryID: string };

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
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;
    const registrations = [];
    if (draggable) {
      registrations.push(
        makeDraggable({
          element,
          canDrag: ({ input }) => input.button === 0,
          getInitialData: () => ({ type: 'category', categoryID: id } satisfies DragPayload),
          onDragStart: () => setDragging(true),
          onDrop: () => setDragging(false),
        }),
      );
    }
    if (dropData) {
      registrations.push(
        dropTargetForElements({
          element,
          getData: ({ input, element }) =>
            attachClosestEdge(dropData, {
              input,
              element,
              allowedEdges: ['top', 'bottom'],
            }),
        }),
      );
    }
    return combine(...registrations);
  }, [draggable, dropData, id]);

  return (
    <div
      ref={elementRef}
      data-testid={testID}
      className={className}
      style={{ opacity: dragging ? 0.25 : undefined }}
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

  useEffect(() => {
    const element = elementRef.current;
    if (!element || disabled) return undefined;
    return dropTargetForElements({
      element,
      getData: () => data,
    });
  }, [data, disabled]);

  return (
    <div ref={elementRef} data-testid={testID} className={className}>
      {children}
    </div>
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
        dragStyle: { opacity: dragging ? 0.25 : undefined },
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
  const updateCategory = useUpdateCategory();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [conversationSort, setConversationSort] = useState<ConversationSidebarSort>(() =>
    localStorage.getItem(CONVERSATION_SORT_STORAGE_KEY) === 'az' ? 'az' : 'recent',
  );
  const activeDragRef = useRef<DragPayload | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const resolvedDropRef = useRef<ResolvedDrop | null>(null);
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
      .map((item) => item.channel)
      .filter((channel) => channel.channelID !== currentDraggedChannel?.channelID);
    const before = channelsOnly[targetIndex - 1]?.sidebarPosition;
    const after = channelsOnly[targetIndex]?.sidebarPosition;

    if (before && after && after - before > 1) return Math.floor((before + after) / 2);
    if (before) return before + SIDEBAR_POSITION_STEP;
    if (after && after > 1) return Math.floor(after / 2);
    if (after !== undefined) return after - SIDEBAR_POSITION_STEP;
    return SIDEBAR_POSITION_STEP;
  }

  function dropChannelInto(sectionKey: string, items: SidebarItem[], targetIndex: number) {
    const currentDraggedChannel = activeDragRef.current?.type === 'channel' ? activeDragRef.current.channel : null;
    if (!currentDraggedChannel) return;
    if (sectionKey === SidebarSectionKeys.DirectMessages) return;
    if (sectionKey === SidebarSectionKeys.Favorites) {
      if (!currentDraggedChannel.favorite) {
        favoriteChannel.mutate({ channelID: currentDraggedChannel.channelID, favorite: true });
      }
      setDropIndicator(null);
      return;
    }
    if (currentDraggedChannel.favorite) {
      favoriteChannel.mutate({ channelID: currentDraggedChannel.channelID, favorite: false });
    }
    setCategory.mutate({
      channelID: currentDraggedChannel.channelID,
      categoryID: sectionCategoryID(sectionKey),
      sidebarPosition: positionForDrop(items, targetIndex),
    });
    setDropIndicator(null);
  }

  function channelCount(items: SidebarItem[]): number {
    return items.filter((item) => item.kind === 'channel').length;
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

  function clearDropTarget() {
    resolvedDropRef.current = null;
    setDropIndicator(null);
  }

  function sortedCategoriesWithoutDragged(): SidebarCategory[] {
    return [...(categories ?? [])]
      .filter((category) => category.id !== (activeDragRef.current?.type === 'category' ? activeDragRef.current.categoryID : null))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }

  function positionForCategoryDrop(targetCategoryID: string): number {
    const ordered = sortedCategoriesWithoutDragged();
    const foundIndex = ordered.findIndex((category) => category.id === targetCategoryID);
    const targetIndex = targetCategoryID === CATEGORY_DROP_END
      ? ordered.length
      : Math.max(0, foundIndex);
    const before = ordered[targetIndex - 1]?.position;
    const after = ordered[targetIndex]?.position;

    if (before && after && after - before > 1) return Math.floor((before + after) / 2);
    if (before) return before + SIDEBAR_POSITION_STEP;
    if (after && after > 1) return Math.floor(after / 2);
    if (after !== undefined) return after - SIDEBAR_POSITION_STEP;
    return SIDEBAR_POSITION_STEP;
  }

  function moveCategoryBefore(targetCategoryID: string) {
    const draggedCategoryID = activeDragRef.current?.type === 'category' ? activeDragRef.current.categoryID : null;
    if (!draggedCategoryID || draggedCategoryID === targetCategoryID) return;
    const draggedCategory = categories?.find((category) => category.id === draggedCategoryID);
    if (!draggedCategory) return;

    updateCategory.mutate({ id: draggedCategoryID, position: positionForCategoryDrop(targetCategoryID) });
    setDropIndicator(null);
  }

  function isChannelDropIndicator(sectionKey: string, index: number, area: ChannelDropArea): boolean {
    return dropIndicator?.kind === 'channel' && dropIndicator.sectionKey === sectionKey && dropIndicator.index === index && dropIndicator.area === area;
  }

  function applyResolvedDrop(drop: ResolvedDrop | null) {
    if (!drop) return;
    if (drop.kind === 'channel') {
      if (activeDragRef.current?.type !== 'channel') return;
      const section = sidebarSections.find((candidate) => candidate.key === drop.sectionKey);
      if (!section) return;
      dropChannelInto(drop.sectionKey, section.items, drop.index);
      return;
    }
    if (activeDragRef.current?.type !== 'category') return;
    moveCategoryBefore(drop.categoryID);
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

  function resolveDropPayload(payload: DropPayload | undefined): ResolvedDrop | null {
    if (!payload) return null;
    const currentDrag = activeDragRef.current;
    if (payload.type === 'channel-target') {
      const edge = extractClosestEdge(payload);
      if (currentDrag?.type === 'category') {
        const categoryID = categoryTargetFromSection(payload.sectionKey, edge, payload.area);
        return categoryID ? { kind: 'category', categoryID } : null;
      }
      if (currentDrag?.type !== 'channel') return null;
      const index = edge === 'bottom' ? payload.index + 1 : payload.index;
      const area = edge === 'bottom' ? 'end' : payload.area;
      return { kind: 'channel', sectionKey: payload.sectionKey, index, area };
    }
    if (payload.type === 'section-header-target') {
      if (currentDrag?.type === 'channel') {
        return channelDropFromSectionHeader(payload.sectionKey, extractClosestEdge(payload));
      }
      if (
        currentDrag?.type === 'category' &&
        payload.categoryID !== currentDrag.categoryID &&
        payload.sectionKey !== SidebarSectionKeys.Favorites
      ) {
        const edge = extractClosestEdge(payload);
        return { kind: 'category', categoryID: edge === 'bottom' ? nextCategoryTarget(payload.categoryID) : payload.categoryID };
      }
    }
    return null;
  }

  function nextCategoryTarget(categoryID: string): string {
    const ordered = [...(categories ?? [])].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    const index = ordered.findIndex((category) => category.id === categoryID);
    return ordered[index + 1]?.id ?? CATEGORY_DROP_END;
  }

  function categoryTargetFromSection(sectionKey: string, edge: Edge | null, area: ChannelDropArea): string | null {
    if (sectionKey === SidebarSectionKeys.Favorites || sectionKey === SidebarSectionKeys.DirectMessages) return null;
    if (sectionKey === SidebarSectionKeys.Channels) return CATEGORY_DROP_END;
    return edge === 'bottom' || area === 'end' ? nextCategoryTarget(sectionKey) : sectionKey;
  }

  function currentDropPayload(location: { dropTargets: Array<{ data: Record<string | symbol, unknown> }> }): DropPayload | undefined {
    return location.dropTargets[0]?.data as DropPayload | undefined;
  }

  function handleDragStart(payload: DragPayload | null) {
    if (suppressNavigationResetRef.current !== null) {
      window.clearTimeout(suppressNavigationResetRef.current);
      suppressNavigationResetRef.current = null;
    }
    activeDragRef.current = payload;
    setSuppressChannelNavigationID(payload?.type === 'channel' ? payload.channel.channelID : null);
    clearDropTarget();
  }

  function updateResolvedDrop(payload: DropPayload | undefined) {
    const resolvedDrop = resolveDropPayload(payload);
    if (!resolvedDrop) {
      if (
        (activeDragRef.current?.type === 'channel' && resolvedDropRef.current?.kind === 'channel') ||
        (activeDragRef.current?.type === 'category' && resolvedDropRef.current?.kind === 'category')
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
    setDropIndicator(resolvedDrop);
  }

  function handleDrop(payload: DropPayload | undefined) {
    applyResolvedDrop(resolvedDropRef.current ?? resolveDropPayload(payload));
    activeDragRef.current = null;
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

  function DropLine({ overlay = false }: { overlay?: boolean }) {
    return (
      <div
        data-testid="sidebar-drop-indicator"
        className={
          overlay
            ? 'pointer-events-none absolute left-2 right-2 top-0 z-10 h-px bg-white/85'
            : 'pointer-events-none mx-2 my-0.5 h-px bg-white/85'
        }
      />
    );
  }

  useEffect(() => {
    return monitorForElements({
      onDragStart: ({ source }) => {
        handleDragStart(source.data as DragPayload);
      },
      onDropTargetChange: ({ location }) => {
        updateResolvedDrop(currentDropPayload(location.current));
      },
      onDrag: ({ location }) => {
        updateResolvedDrop(currentDropPayload(location.current));
      },
      onDrop: ({ location }) => {
        handleDrop(currentDropPayload(location.current));
      },
    });
  });

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
                <div key={section.key} className="mt-2" data-testid={`sidebar-group-${section.key}`}>
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
                      dropIndicator.categoryID === (isChannelsDefault ? CATEGORY_DROP_END : section.key) && (
                        <DropLine overlay />
                      )}
                    <button
                      onClick={() =>
                        setCollapsedGroups((prev) => ({ ...prev, [section.key]: !collapsed }))
                      }
                      aria-expanded={!collapsed}
                      data-testid={`sidebar-group-toggle-${section.key}`}
                      className="flex flex-1 items-center gap-1 rounded-md px-2 py-1 text-sm font-semibold text-gray-400 hover:bg-white/5"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${collapsed ? '-rotate-90' : ''}`}
                      />
                      <span className="truncate">{section.title}</span>
                    </button>
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
                      <DropLine overlay />
                    </div>
                  )}
                  <PragmaticSection
                    data={{ type: 'channel-target', sectionKey: section.key, index: channelCount(visibleItems), area: 'end' }}
                    disabled={!canDropChannel}
                    className="min-h-2 space-y-px pb-2"
                    testID={canDropChannel ? `sidebar-section-tail-drop-${section.key}` : undefined}
                  >
                    {visibleItems.map((item, index) => {
                      if (item.kind === 'channel') {
                        const channelDropIndex = visibleItems
                          .slice(0, index)
                          .filter((candidate) => candidate.kind === 'channel').length;
                        return (
                          <div
                            key={`ch-${item.channel.channelID}`}
                            className="relative"
                          >
                            {isChannelDropIndicator(section.key, channelDropIndex, 'row') && <DropLine overlay />}
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
                      const isGroup = conv.type === 'group';
                      const otherID = !isGroup
                        ? ((conv.participantIDs ?? []).find((p) => p !== user?.id) ?? conv.participantIDs?.[0])
                        : undefined;
                      const dmAvatarURL = otherID ? dmUserMap.get(otherID)?.avatarURL : undefined;
                      return (
                        <ConversationRow
                          key={`conv-${conv.conversationID}`}
                          conversation={conv}
                          hasUnread={unreadConversations.has(conv.conversationID)}
                          dmAvatarURL={dmAvatarURL}
                          onClose={onClose}
                          onHide={hideConversation}
                        />
                      );
                    })}
                    {isChannelDropIndicator(section.key, channelCount(visibleItems), 'end') && <DropLine />}
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
