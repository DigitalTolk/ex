import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Star, MoreVertical, X } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getInitials } from '@/lib/format';
import {
  useFavoriteConversation,
  useSetConversationCategory,
  useCategories,
  useCreateCategory,
} from '@/hooks/useSidebar';
import type { UserConversation, SidebarCategory } from '@/types';

interface Props {
  conversation: UserConversation;
  hasUnread: boolean;
  dmAvatarURL?: string;
  onClose: () => void;
  onHide: (convID: string) => void;
}

// ConversationRow is one row in the sidebar's DM/group list. It owns
// the same per-row interactions as ChannelRow — favorite toggle, kebab
// menu for moving between categories or creating a new one — plus the
// existing X-button to hide the conversation.
export function ConversationRow({ conversation, hasUnread, dmAvatarURL, onClose, onHide }: Props) {
  const favorite = useFavoriteConversation();
  const setCategory = useSetConversationCategory();
  const { data: categories } = useCategories();
  const createCategory = useCreateCategory();
  const [creatingNewCategory, setCreatingNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

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

  function handleCreateAndAssign() {
    const name = newCategoryName.trim();
    if (!name) return;
    createCategory.mutate(name, {
      onSuccess: (cat) => {
        setCategory.mutate({ conversationID: conversation.conversationID, categoryID: cat.id });
        setNewCategoryName('');
        setCreatingNewCategory(false);
      },
    });
  }

  return (
    <div className="group/row relative flex items-center">
      <NavLink
        to={`/conversation/${conversation.conversationID}`}
        onClick={onClose}
        className={({ isActive }) =>
          `flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors ${
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
        <span className="truncate">{conversation.displayName}</span>
        {hasUnread && <span className="ml-auto h-2 w-2 rounded-full bg-white" />}
      </NavLink>
      {/* Star — visible on hover; persistent yellow when favorited. */}
      <button
        onClick={toggleFavorite}
        aria-label={isFav ? `Unfavorite ${conversation.displayName}` : `Favorite ${conversation.displayName}`}
        data-testid={`conv-fav-toggle-${conversation.conversationID}`}
        className={`absolute right-12 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded transition-opacity ${
          isFav ? 'opacity-100 text-amber-300' : 'opacity-0 group-hover/row:opacity-100 text-gray-400 hover:text-white'
        }`}
      >
        <Star className="h-3.5 w-3.5" fill={isFav ? 'currentColor' : 'none'} />
      </button>
      {/* Kebab — move-to-category. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Manage ${conversation.displayName} sidebar placement`}
          data-testid={`conv-row-menu-${conversation.conversationID}`}
          className="absolute right-6 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/row:opacity-100 hover:bg-white/20 hover:text-white"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => moveToCategory('')}>
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
          {creatingNewCategory ? (
            <div className="px-2 py-1.5">
              <input
                autoFocus
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateAndAssign();
                  if (e.key === 'Escape') setCreatingNewCategory(false);
                }}
                placeholder="Category name"
                className="w-full rounded-md border bg-background px-2 py-1 text-sm text-foreground"
                data-testid="conv-new-category-input"
              />
            </div>
          ) : (
            <DropdownMenuItem onClick={() => setCreatingNewCategory(true)}>
              + New category…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Hide-conversation X — always at the right edge, hover-only. */}
      <button
        onClick={(e) => { e.preventDefault(); onHide(conversation.conversationID); }}
        className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 h-5 w-5 flex items-center justify-center rounded hover:bg-white/20 text-gray-400 hover:text-white"
        aria-label="Close conversation"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
