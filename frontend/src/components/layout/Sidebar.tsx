import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  Hash,
  Lock,
  Plus,
  ChevronDown,
  LogOut,
  BookUser,
  UserPlus,
  X,
  User as UserIcon,
  Smile,
  BellOff,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { getInitials, slugify } from '@/lib/format';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { CreateChannelDialog } from '@/components/channels/CreateChannelDialog';
import { InviteDialog } from '@/components/InviteDialog';
import { EditProfileDialog } from '@/components/EditProfileDialog';
import { NewConversationDialog } from '@/components/conversations/NewConversationDialog';
import { EmojiManagerDialog } from '@/components/EmojiManagerDialog';

interface SidebarProps {
  onClose: () => void;
}

export function Sidebar({ onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const { unreadChannels, unreadConversations, hiddenConversations, hideConversation } = useUnread();
  const { data: channels } = useUserChannels();
  const { data: conversations } = useUserConversations();
  const navigate = useNavigate();
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [newConvoOpen, setNewConvoOpen] = useState(false);
  const [emojiManagerOpen, setEmojiManagerOpen] = useState(false);

  const visibleConversations = conversations?.filter(c => !hiddenConversations.has(c.conversationID));

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
              {user?.systemRole === 'admin' && (
                <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0 bg-white/20 text-white border-0">
                  Admin
                </Badge>
              )}
              <ChevronDown className="h-4 w-4 text-gray-400" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {user?.systemRole === 'admin' && (
              <DropdownMenuItem onClick={() => setInviteOpen(true)}>
                <UserPlus className="mr-2 h-4 w-4" />
                Invite people
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setEditProfileOpen(true)}>
              <UserIcon className="mr-2 h-4 w-4" />
              Edit profile
            </DropdownMenuItem>
            {user?.systemRole !== 'guest' && (
              <DropdownMenuItem onClick={() => setEmojiManagerOpen(true)}>
                <Smile className="mr-2 h-4 w-4" />
                Custom emojis
              </DropdownMenuItem>
            )}
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

          {/* Channels section */}
          <div className="mb-1">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Channels
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-gray-400 hover:bg-white/10 hover:text-white"
                onClick={() => setCreateChannelOpen(true)}
                aria-label="Create channel"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <nav aria-label="Channels">
              {channels?.map((ch) => {
                const hasUnread = unreadChannels.has(ch.channelID);
                return (
                  <NavLink
                    key={ch.channelID}
                    to={`/channel/${slugify(ch.channelName)}`}
                    onClick={onClose}
                    className={({ isActive }) =>
                      `flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors ${
                        isActive
                          ? 'bg-white/15 text-white font-semibold'
                          : hasUnread
                            ? 'font-bold text-white hover:bg-white/10'
                            : 'text-gray-300 hover:bg-white/10 hover:text-white'
                      }`
                    }
                  >
                    {ch.channelType === 'private' ? (
                      <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
                    ) : (
                      <Hash className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    <span className={`truncate ${ch.muted ? 'text-gray-500' : ''}`}>
                      {ch.channelName}
                    </span>
                    {ch.muted && (
                      <BellOff
                        className="ml-auto h-3 w-3 shrink-0 text-gray-500"
                        aria-label="Muted"
                      />
                    )}
                    {hasUnread && !ch.muted && (
                      <span className="ml-auto h-2 w-2 rounded-full bg-white" />
                    )}
                  </NavLink>
                );
              })}
            </nav>
          </div>

          <Separator className="my-2 bg-white/10" />

          {/* Direct Messages section */}
          <div>
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Direct Messages
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-gray-400 hover:bg-white/10 hover:text-white"
                onClick={() => setNewConvoOpen(true)}
                aria-label="New direct message"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <nav aria-label="Direct messages">
              {visibleConversations?.map((conv) => {
                const hasUnread = unreadConversations.has(conv.conversationID);
                const isGroup = conv.type === 'group';
                const participantCount = isGroup ? (conv.participantIDs?.length ?? 0) : 0;
                return (
                  <div key={conv.conversationID} className="group relative">
                    <NavLink
                      to={`/conversation/${conv.conversationID}`}
                      onClick={onClose}
                      className={({ isActive }) =>
                        `flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors ${
                          isActive
                            ? 'bg-white/15 text-white font-semibold'
                            : hasUnread
                              ? 'font-bold text-white hover:bg-white/10'
                              : 'text-gray-300 hover:bg-white/10 hover:text-white'
                        }`
                      }
                    >
                      {isGroup ? (
                        <Badge
                          variant="secondary"
                          className="shrink-0 h-5 min-w-5 px-1.5 bg-white/20 text-white border-0 text-[10px]"
                          aria-label={`${participantCount} participants`}
                        >
                          {participantCount}
                        </Badge>
                      ) : (
                        <Avatar className="h-5 w-5 shrink-0">
                          <AvatarFallback className="text-[10px] bg-emerald-700 text-white">
                            {getInitials(conv.displayName || '??')}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      <span className="truncate">{conv.displayName}</span>
                      {hasUnread && <span className="ml-auto h-2 w-2 rounded-full bg-white" />}
                    </NavLink>
                    <button
                      onClick={(e) => { e.preventDefault(); hideConversation(conv.conversationID); }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded hover:bg-white/20 text-gray-400 hover:text-white"
                      aria-label="Close conversation"
                    >
                      <X className="h-3 w-3" />
                    </button>
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
      <NewConversationDialog open={newConvoOpen} onOpenChange={setNewConvoOpen} />
      <EmojiManagerDialog open={emojiManagerOpen} onOpenChange={setEmojiManagerOpen} />
    </div>
  );
}
