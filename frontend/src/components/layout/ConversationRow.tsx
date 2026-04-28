import { NavLink } from 'react-router-dom';
import { Star, MoreVertical } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getInitials, firstNamesOnly } from '@/lib/format';
import {
  useFavoriteConversation,
  useSetConversationCategory,
  useCategories,
} from '@/hooks/useSidebar';
import type { UserConversation, SidebarCategory } from '@/types';

interface Props {
  conversation: UserConversation;
  hasUnread: boolean;
  dmAvatarURL?: string;
  onClose: () => void;
  onHide: (convID: string) => void;
}

// ConversationRow is one row in the sidebar's DM/group list. It owns the
// same per-row interactions as ChannelRow — favorite toggle plus a kebab
// menu for moving between categories. Closing the conversation lives in
// the same kebab so a DM row keeps the exact button layout (star + …)
// every other sidebar row uses.
export function ConversationRow({ conversation, hasUnread, dmAvatarURL, onClose, onHide }: Props) {
  const favorite = useFavoriteConversation();
  const setCategory = useSetConversationCategory();
  const { data: categories } = useCategories();

  const isFav = !!conversation.favorite;
  const isGroup = conversation.type === 'group';
  const participantCount = isGroup ? (conversation.participantIDs?.length ?? 0) : 0;

  function toggleFavorite(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    favorite.mutate({ conversationID: conversation.conversationID, favorite: !isFav });
  }

  function moveToCategory(categoryID: string) {
    setCategory.mutate({ conversationID: conversation.conversationID, categoryID });
  }

  return (
    <div className="group/row relative flex items-center">
      <NavLink
        to={`/conversation/${conversation.conversationID}`}
        onClick={onClose}
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
          <Badge
            variant="secondary"
            className="shrink-0 h-5 min-w-5 px-1.5 bg-white/20 text-white border-0 text-[10px]"
            aria-label={`${participantCount} participants`}
          >
            {participantCount}
          </Badge>
        ) : (
          <Avatar className="h-5 w-5 shrink-0">
            {dmAvatarURL && <AvatarImage src={dmAvatarURL} alt="" />}
            <AvatarFallback className="text-[10px] bg-emerald-700 text-white">
              {getInitials(conversation.displayName || '??')}
            </AvatarFallback>
          </Avatar>
        )}
        {/* DMs keep the full name; group rows show first-names only
            because the comma-joined list of full names ("Alice Smith,
            Bob Jones, Charlie Brown") immediately overflows. */}
        <span className="truncate">
          {isGroup
            ? firstNamesOnly(conversation.displayName)
            : conversation.displayName}
        </span>
        {hasUnread && (
          <span
            data-testid="unread-dot"
            className="ml-auto h-2 w-2 rounded-full bg-white group-hover/row:hidden"
          />
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
      {/* Kebab — move-to-category and close. Same right-1 slot as ChannelRow. */}
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
            onClick={() => moveToCategory('')}
            disabled={!conversation.categoryID}
          >
            Move to Direct Messages
          </DropdownMenuItem>
          {(categories ?? []).map((c: SidebarCategory) => (
            <DropdownMenuItem
              key={c.id}
              onClick={() => moveToCategory(c.id)}
              disabled={conversation.categoryID === c.id}
            >
              Move to {c.name}
            </DropdownMenuItem>
          ))}
          <div className="my-1 h-px bg-border" />
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
