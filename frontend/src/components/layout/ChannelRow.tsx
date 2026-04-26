import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Hash, Lock, Star, BellOff, MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { slugify } from '@/lib/format';
import { useFavoriteChannel, useSetCategory, useCategories, useCreateCategory } from '@/hooks/useSidebar';
import type { UserChannel, SidebarCategory } from '@/types';

interface Props {
  channel: UserChannel;
  hasUnread: boolean;
  onClose: () => void;
}

// ChannelRow is one row in the sidebar's channels list. It owns the
// per-row interactions: the star (favorite toggle) and the kebab menu
// for moving the channel between categories or creating a new one.
export function ChannelRow({ channel, hasUnread, onClose }: Props) {
  const favorite = useFavoriteChannel();
  const setCategory = useSetCategory();
  const { data: categories } = useCategories();
  const createCategory = useCreateCategory();
  const [creatingNewCategory, setCreatingNewCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  const isFav = !!channel.favorite;

  function toggleFavorite(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    favorite.mutate({ channelID: channel.channelID, favorite: !isFav });
  }

  function moveToCategory(categoryID: string) {
    setCategory.mutate({ channelID: channel.channelID, categoryID });
  }

  function handleCreateAndAssign() {
    const name = newCategoryName.trim();
    if (!name) return;
    createCategory.mutate(name, {
      onSuccess: (cat) => {
        setCategory.mutate({ channelID: channel.channelID, categoryID: cat.id });
        setNewCategoryName('');
        setCreatingNewCategory(false);
      },
    });
  }

  return (
    <div className="group/row relative flex items-center">
      <NavLink
        to={`/channel/${slugify(channel.channelName)}`}
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
        {channel.channelType === 'private' ? (
          <Lock className="h-4 w-4 shrink-0" aria-hidden="true" />
        ) : (
          <Hash className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span className={`truncate ${channel.muted ? 'text-gray-500' : ''}`}>
          {channel.channelName}
        </span>
        {channel.muted && (
          <BellOff className="ml-auto h-3 w-3 shrink-0 text-gray-500" aria-label="Muted" />
        )}
        {hasUnread && !channel.muted && (
          <span className="ml-auto h-2 w-2 rounded-full bg-white" />
        )}
      </NavLink>
      {/* Star — visible on hover; persistent yellow when favorited. */}
      <button
        onClick={toggleFavorite}
        aria-label={isFav ? `Unfavorite ${channel.channelName}` : `Favorite ${channel.channelName}`}
        data-testid={`fav-toggle-${channel.channelID}`}
        className={`absolute right-7 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded transition-opacity ${
          isFav ? 'opacity-100 text-amber-300' : 'opacity-0 group-hover/row:opacity-100 text-gray-400 hover:text-white'
        }`}
      >
        <Star className="h-3.5 w-3.5" fill={isFav ? 'currentColor' : 'none'} />
      </button>
      {/* Kebab — move to category. Always visible on hover. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Manage ${channel.channelName} sidebar placement`}
          data-testid={`row-menu-${channel.channelID}`}
          className="absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-gray-400 opacity-0 group-hover/row:opacity-100 hover:bg-white/20 hover:text-white"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onClick={() => moveToCategory('')}>
            Move to Other
          </DropdownMenuItem>
          {(categories ?? []).map((c: SidebarCategory) => (
            <DropdownMenuItem
              key={c.id}
              onClick={() => moveToCategory(c.id)}
              disabled={channel.categoryID === c.id}
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
                data-testid="new-category-input"
              />
            </div>
          ) : (
            <DropdownMenuItem onClick={() => setCreatingNewCategory(true)}>
              + New category…
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
