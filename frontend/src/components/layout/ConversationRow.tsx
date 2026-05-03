import { NavLink } from 'react-router-dom';
import { Star, MoreVertical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import { UserStatusIndicator } from '@/components/UserStatusIndicator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { firstNamesOnly } from '@/lib/format';
import {
  useFavoriteConversation,
  useSetConversationCategory,
} from '@/hooks/useSidebar';
import type { UserConversation, UserStatus } from '@/types';
import type { CSSProperties } from 'react';

interface Props {
  conversation: UserConversation;
  hasUnread: boolean;
  dmAvatarURL?: string;
  dmUserStatus?: UserStatus;
  dmOnline?: boolean;
  onClose: () => void;
  onHide: (convID: string) => void;
  draggable?: boolean;
  dragRef?: (node: HTMLElement | null) => void;
  dragStyle?: CSSProperties;
  suppressNavigation?: boolean;
  onSuppressNavigationConsumed?: () => void;
}

// ConversationRow is one row in the sidebar's DM/group list. It owns the
// same per-row interactions as ChannelRow — favorite toggle plus a kebab
// menu for moving between categories. Closing the conversation lives in
// the same kebab so a DM row keeps the exact button layout (star + …)
// every other sidebar row uses.
export function ConversationRow({
  conversation,
  hasUnread,
  dmAvatarURL,
  dmUserStatus,
  dmOnline,
  onClose,
  onHide,
  draggable,
  dragRef,
  dragStyle,
  suppressNavigation,
  onSuppressNavigationConsumed,
}: Props) {
  const favorite = useFavoriteConversation();
  const setCategory = useSetConversationCategory();

  const isFav = !!conversation.favorite;
  const isGroup = conversation.type === 'group';
  const participantCount = isGroup ? (conversation.participantIDs?.length ?? 0) : 0;

  function toggleFavorite(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (isFav) {
      setCategory.mutate({
        conversationID: conversation.conversationID,
        categoryID: conversation.categoryID ?? '',
        sidebarPosition: 0,
      });
    }
    favorite.mutate({ conversationID: conversation.conversationID, favorite: !isFav });
  }

  return (
    <div
      ref={dragRef}
      className={`group/row relative flex items-center ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      data-testid={`conversation-row-${conversation.conversationID}`}
      style={dragStyle}
    >
      <NavLink
        to={`/conversation/${conversation.conversationID}`}
        onClick={(event) => {
          if (suppressNavigation) {
            event.preventDefault();
            event.stopPropagation();
            onSuppressNavigationConsumed?.();
            return;
          }
          onClose();
        }}
        draggable={false}
        className={({ isActive }) =>
          `flex flex-1 min-w-0 items-center gap-2 rounded-md py-1 pl-2 pr-12 text-sm transition-colors ${
            isActive
              ? 'bg-white/15 text-white font-semibold'
              : hasUnread
                ? 'font-bold text-white hover:bg-white/10'
                : 'text-gray-300 hover:bg-white/10 hover:text-white'
          }`
        }
      >
        {isGroup ? (
          <>
            <Badge
              variant="secondary"
              className="shrink-0 h-5 min-w-5 px-1.5 bg-white/20 text-white border-0 text-[10px]"
              aria-label={`${participantCount} participants`}
            >
              {participantCount}
            </Badge>
            <span className="truncate">{firstNamesOnly(conversation.displayName)}</span>
          </>
        ) : (
          <>
            <UserAvatar
              displayName={conversation.displayName || '??'}
              avatarURL={dmAvatarURL}
              online={dmOnline}
              userStatus={dmUserStatus}
              className="h-5 w-5"
              dotClassName="h-1.5 w-1.5"
            />
            <span className="truncate">{conversation.displayName}</span>
            <UserStatusIndicator status={dmUserStatus} className="h-4 w-4" />
          </>
        )}
      </NavLink>
      {/* Star — visible on hover; persistent yellow when favorited.
          Positioned to match ChannelRow's right-7 / right-1 layout. */}
      <button
        onClick={toggleFavorite}
        aria-label={isFav ? `Unfavorite ${conversation.displayName}` : `Favorite ${conversation.displayName}`}
        data-testid={`conv-fav-toggle-${conversation.conversationID}`}
        className={`absolute right-7 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded transition-opacity ${
          isFav ? 'opacity-100 text-amber-300' : 'opacity-0 group-hover/row:opacity-100 text-gray-400 hover:text-white'
        }`}
      >
        <Star className="h-3.5 w-3.5" fill={isFav ? 'currentColor' : 'none'} />
      </button>
      {/* Kebab — close only. Category placement is intentionally channel-only;
          DMs/groups move to Favorites through the star. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Manage ${conversation.displayName} sidebar placement`}
          data-testid={`conv-row-menu-${conversation.conversationID}`}
          className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/row:opacity-100 hover:bg-white/20 hover:text-white"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onClick={() => onHide(conversation.conversationID)}
            data-testid={`conv-close-${conversation.conversationID}`}
          >
            Close conversation
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
