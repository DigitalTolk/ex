import { NavLink } from 'react-router-dom';
import { Star, BellOff, MoreVertical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ChannelIcon } from '@/components/ChannelIcon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { slugify } from '@/lib/format';
import { useFavoriteChannel, useSetCategory, useCategories } from '@/hooks/useSidebar';
import { useRowLongPressMenu } from '@/hooks/useRowLongPressMenu';
import type { UserChannel, SidebarCategory } from '@/types';
import { type CSSProperties } from 'react';

interface Props {
  channel: UserChannel;
  hasUnread: boolean;
  // Live count of unread messages observed this session (incremented
  // per WebSocket message.new while the channel isn't active). 0 when
  // unknown — e.g. on a cold load, where unread is only known as a
  // boolean — in which case the row falls back to the unread dot.
  unreadCount?: number;
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
  unreadCount = 0,
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
  // Mobile long-press opens the (otherwise hidden) row menu; shared with
  // the other sidebar row type so the behavior can't drift.
  const { menuOpen, setMenuOpen, rowHandlers, suppressNavClick } = useRowLongPressMenu();

  const isFav = !!channel.favorite;

  function toggleFavorite(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!isFav) {
      setCategory.mutate({ channelID: channel.channelID, categoryID: '' });
    }
    favorite.mutate({ channelID: channel.channelID, favorite: !isFav });
  }

  function moveToCategory(categoryID: string) {
    if (isFav) {
      favorite.mutate({ channelID: channel.channelID, favorite: false });
    }
    setCategory.mutate({ channelID: channel.channelID, categoryID });
  }

  return (
    <div
      ref={dragRef}
      className={`group/row relative flex items-center ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      data-testid={`channel-row-${channel.channelID}`}
      style={dragStyle}
      {...rowHandlers}
    >
      <NavLink
        to={`/channel/${slugify(channel.channelName)}`}
        onClick={(event) => {
          // A touch long-press that opened the menu also fires a click on
          // release; swallow it so the row doesn't navigate.
          if (suppressNavClick()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
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
          `relative flex flex-1 min-w-0 items-center gap-2 rounded-md py-1.5 pl-2 pr-12 text-sm transition-colors max-md:h-12 max-md:py-0 max-md:pl-3 max-md:pr-20 max-md:text-base ${
            isActive
              ? 'bg-background text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
              : hasUnread
                ? 'font-bold text-white hover:bg-white/10'
                : 'text-gray-300 hover:bg-white/10 hover:text-white'
          }`
        }
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <ChannelIcon type={channel.channelType} className="h-4 w-4" ariaLabel="" />
        </span>
        <span className={`truncate ${channel.muted ? 'text-gray-500' : ''}`}>
          {channel.channelName}
        </span>
        {/* Right-edge status, absolutely positioned so it sits flush to the edge
            and NEVER reflows: an unread channel shows a brand-pink NUMBERED count
            box (floored to 1 — a cold load where the exact count isn't seeded yet
            reads as "1", per the design), a muted+unread channel a subtle dot
            instead of the loud count, and a muted+read channel the bell. It
            fades out on desktop hover so the row actions (star/kebab) take the
            space, and stays visible on touch where those actions are persistent
            (shifted left of them). pointer-events-none keeps the row clickable. */}
        {hasUnread ? (
          <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center transition-opacity group-hover/row:opacity-0 max-md:right-12 max-md:opacity-100">
            {channel.muted ? (
              <span
                aria-label="Unread"
                data-testid={`channel-unread-dot-${channel.channelID}`}
                className="h-2 w-2 rounded-full bg-brand"
              />
            ) : (
              <Badge variant="brand" className="text-[11px]" data-testid={`channel-unread-badge-${channel.channelID}`}>
                {unreadCount > 99 ? '99+' : Math.max(1, unreadCount)}
              </Badge>
            )}
          </span>
        ) : channel.muted ? (
          <BellOff
            className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-gray-500 transition-opacity group-hover/row:opacity-0 max-md:opacity-100"
            aria-label="Muted"
          />
        ) : null}
      </NavLink>
      {/* Star — visible on hover; persistent yellow when favorited. Always visible on touch screens. */}
      <button
        onClick={toggleFavorite}
        aria-label={isFav ? `Unfavorite ${channel.channelName}` : `Favorite ${channel.channelName}`}
        data-testid={`fav-toggle-${channel.channelID}`}
        className={`absolute right-7 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition-opacity max-md:right-10 max-md:h-9 max-md:w-9 ${
          isFav ? 'opacity-100 text-amber-300' : 'opacity-0 text-gray-400 hover:text-white group-hover/row:opacity-100 max-md:opacity-100'
        }`}
      >
        <Star className="h-3.5 w-3.5" fill={isFav ? 'currentColor' : 'none'} />
      </button>
      {/* Kebab — move to category. Desktop: revealed on row hover. Mobile: the
          trigger is NOT a tap target (a long-press on the row opens it) but stays
          mounted + hidden so Radix can anchor the menu to it. */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          aria-label={`Manage ${channel.channelName} sidebar placement`}
          data-testid={`row-menu-${channel.channelID}`}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-gray-400 opacity-0 hover:bg-white/20 hover:text-white group-hover/row:opacity-100 max-md:pointer-events-none max-md:opacity-0"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onClick={() => moveToCategory('')}
            disabled={!channel.categoryID && !isFav}
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
