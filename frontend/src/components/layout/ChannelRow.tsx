import { NavLink } from 'react-router-dom';
import { Star, BellOff, MoreVertical } from 'lucide-react';
import { ChannelIcon } from '@/components/ChannelIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { slugify } from '@/lib/format';
import { useFavoriteChannel, useSetCategory, useCategories } from '@/hooks/useSidebar';
import type { UserChannel, SidebarCategory } from '@/types';
import type { CSSProperties } from 'react';

interface Props {
  channel: UserChannel;
  hasUnread: boolean;
  onClose: () => void;
  draggable?: boolean;
  dragRef?: (node: HTMLElement | null) => void;
  dragStyle?: CSSProperties;
  suppressNavigation?: boolean;
  onSuppressNavigationConsumed?: () => void;
}

// ChannelRow is one row in the sidebar's channels list. It owns the
// per-row interactions: the star (favorite toggle) and the kebab menu
// for moving the channel between existing categories. Creating a new
// category lives in the sidebar header so the row menu stays terse.
export function ChannelRow({
  channel,
  hasUnread,
  onClose,
  draggable,
  dragRef,
  dragStyle,
  suppressNavigation,
  onSuppressNavigationConsumed,
}: Props) {
  const favorite = useFavoriteChannel();
  const setCategory = useSetCategory();
  const { data: categories } = useCategories();

  const isFav = !!channel.favorite;

  function toggleFavorite(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (isFav) {
      setCategory.mutate({ channelID: channel.channelID, categoryID: '' });
    }
    favorite.mutate({ channelID: channel.channelID, favorite: !isFav });
  }

  function moveToCategory(categoryID: string) {
    setCategory.mutate({ channelID: channel.channelID, categoryID });
  }

  return (
    <div
      ref={dragRef}
      className={`group/row relative flex items-center ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      data-testid={`channel-row-${channel.channelID}`}
      style={dragStyle}
    >
      <NavLink
        to={`/channel/${slugify(channel.channelName)}`}
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
        <ChannelIcon type={channel.channelType} className="h-4 w-4 shrink-0" ariaLabel="" />
        <span className={`truncate ${channel.muted ? 'text-gray-500' : ''}`}>
          {channel.channelName}
        </span>
        {channel.muted && (
          <BellOff className="ml-auto h-3 w-3 shrink-0 text-gray-500 group-hover/row:hidden" aria-label="Muted" />
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
          <DropdownMenuItem
            onClick={() => moveToCategory('')}
            disabled={!channel.categoryID}
          >
            Move to Channels
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
