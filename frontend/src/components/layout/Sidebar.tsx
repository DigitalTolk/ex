import { useState, useMemo, useRef } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
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
import { useCategories, useCreateCategory, useDeleteCategory } from '@/hooks/useSidebar';
import { groupSidebarItems, SidebarSectionKeys } from '@/lib/sidebar-groups';
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

export function Sidebar({ onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const { unreadChannels, unreadConversations, hiddenConversations, hideConversation } = useUnread();
  const { data: channels } = useUserChannels();
  const { data: conversations } = useUserConversations();
  const { data: threads } = useUserThreads();
  const { data: categories } = useCategories();
  const createCategory = useCreateCategory();
  const deleteCategory = useDeleteCategory();
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
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
    () => groupSidebarItems(channels ?? [], visibleConversations, categories ?? []),
    [channels, visibleConversations, categories],
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
            <span>Threads</span>
            {hasThreadUpdates && (
              <span
                data-testid="threads-unread-dot"
                className="ml-auto h-2 w-2 rounded-full bg-white"
                aria-label="Unread thread activity"
              />
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
              // Favorites is hidden when empty — empty defaults still
              // render so the user always has a "+" target for new
              // channels and DMs, and user categories always render so
              // the user can drop items into them.
              if (isFavorites && section.items.length === 0) return null;
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
                  <div className="group/sec relative flex items-center">
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
                      <button
                        onClick={() => navigate('/conversations/new')}
                        aria-label="New direct message"
                        title="New direct message"
                        data-testid="sidebar-new-dm"
                        className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/sec:opacity-100 hover:bg-white/20 hover:text-white"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
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
                  </div>
                  <div className="space-y-px">
                    {visibleItems.map((item) => {
                      if (item.kind === 'channel') {
                        return (
                          <ChannelRow
                            key={`ch-${item.channel.channelID}`}
                            channel={item.channel}
                            hasUnread={unreadChannels.has(item.channel.channelID)}
                            onClose={onClose}
                          />
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
                  </div>
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
