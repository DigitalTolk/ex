import { useState, useMemo } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useUsersBatch } from '@/hooks/useUsersBatch';
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
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useUserThreads, hasUnreadActivity } from '@/hooks/useThreads';
import { useCategories, useCreateCategory } from '@/hooks/useSidebar';
import { groupSidebarItems, SidebarSectionKeys } from '@/lib/sidebar-groups';
import { ChannelRow } from './ChannelRow';
import { ConversationRow } from './ConversationRow';
import { CreateChannelDialog } from '@/components/channels/CreateChannelDialog';
import { InviteDialog } from '@/components/InviteDialog';
import { EditProfileDialog } from '@/components/EditProfileDialog';
import { AboutDialog } from '@/components/AboutDialog';
import { EmojiManagerDialog } from '@/components/EmojiManagerDialog';

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
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const navigate = useNavigate();
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [emojiManagerOpen, setEmojiManagerOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

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

  return (
    <div className="flex h-full flex-col text-gray-300">
      {/* User section */}
      <div className="flex items-center gap-2 border-b border-white/10 p-3">
        <DropdownMenu>
          <DropdownMenuTrigger
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
            {isAdmin(user?.systemRole) && (
              <DropdownMenuItem onClick={() => setInviteOpen(true)}>
                <UserPlus className="mr-2 h-4 w-4" />
                Invite people
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setEditProfileOpen(true)}>
              <UserIcon className="mr-2 h-4 w-4" />
              Edit profile
            </DropdownMenuItem>
            {!isGuest(user?.systemRole) && (
              <DropdownMenuItem onClick={() => setEmojiManagerOpen(true)}>
                <Smile className="mr-2 h-4 w-4" />
                Custom emojis
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setAboutOpen(true)}>
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

      <ScrollArea className="flex-1">
        <div className="p-2">
          {/* Directories link */}
          <NavLink
            to="/directory"
            onClick={onClose}
            className={({ isActive }) =>
              `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors mb-2 ${
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
              `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors mb-2 ${
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

          {/* Admin link — only visible to admins. Workspace settings
              (upload limits, etc.) live on this page. */}
          {isAdmin(user?.systemRole) && (
            <NavLink
              to="/admin"
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors mb-2 ${
                  isActive
                    ? 'bg-white/15 text-white font-semibold'
                    : 'text-gray-300 hover:bg-white/10 hover:text-white'
                }`
              }
            >
              <Settings className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>Admin</span>
            </NavLink>
          )}

          {/* Unified sidebar list: Favorites (mixed) → user categories
              (mixed) → Channels (uncategorised) → Direct Messages
              (uncategorised). Both channels and DMs/groups can live in
              any user-defined category; favorites mix everything pinned
              by the user at the top. */}
          <div className="mb-1">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Browse
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-gray-400 hover:bg-white/10 hover:text-white"
                  onClick={() => setCreatingCategory(true)}
                  aria-label="New category"
                  data-testid="new-category-button"
                  title="New category"
                >
                  <BookUser className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-gray-400 hover:bg-white/10 hover:text-white"
                  onClick={() => navigate('/conversations/new')}
                  aria-label="New direct message"
                  title="New direct message"
                >
                  <UserPlus className="h-4 w-4" />
                </Button>
                {!isGuest(user?.systemRole) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-gray-400 hover:bg-white/10 hover:text-white"
                    onClick={() => setCreateChannelOpen(true)}
                    aria-label="Create channel"
                    title="Create channel"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {creatingCategory && (
              <div className="px-2 py-1">
                <input
                  autoFocus
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const name = newCategoryName.trim();
                      if (!name) return;
                      createCategory.mutate(name, {
                        onSuccess: () => {
                          setNewCategoryName('');
                          setCreatingCategory(false);
                        },
                      });
                    }
                    if (e.key === 'Escape') setCreatingCategory(false);
                  }}
                  placeholder="Category name…"
                  data-testid="sidebar-new-category-input"
                  className="w-full rounded-md bg-white/10 px-2 py-1 text-sm text-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-white/40"
                />
              </div>
            )}

            <nav aria-label="Channels and direct messages">
              {sidebarSections.map((section) => {
                // Hide truly-empty default sections (Favorites/Channels/
                // Direct Messages) so the sidebar doesn't show a wall of
                // empty headers. User-defined categories always render
                // so the user can drop items into them.
                const isDefault =
                  section.key === SidebarSectionKeys.Favorites ||
                  section.key === SidebarSectionKeys.Channels ||
                  section.key === SidebarSectionKeys.DirectMessages;
                if (isDefault && section.items.length === 0) return null;
                const collapsed = !!collapsedGroups[section.key];
                return (
                  <div key={section.key} className="mt-1" data-testid={`sidebar-group-${section.key}`}>
                    <button
                      onClick={() =>
                        setCollapsedGroups((prev) => ({ ...prev, [section.key]: !collapsed }))
                      }
                      aria-expanded={!collapsed}
                      data-testid={`sidebar-group-toggle-${section.key}`}
                      className="w-full flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 hover:bg-white/5"
                    >
                      <ChevronDown
                        className={`h-3 w-3 transition-transform ${collapsed ? '-rotate-90' : ''}`}
                      />
                      <span className="flex items-center gap-1">
                        {section.key === SidebarSectionKeys.Favorites && (
                          <BookUser className="h-3 w-3 text-amber-300" aria-hidden="true" />
                        )}
                        {section.title}
                      </span>
                      <span className="ml-auto opacity-70">{section.items.length}</span>
                    </button>
                    {!collapsed && (
                      <div>
                        {section.items.map((item) => {
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
                    )}
                  </div>
                );
              })}
            </nav>
          </div>
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
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
    </div>
  );
}
