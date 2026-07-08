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
import { useRowLongPressMenu } from '@/hooks/useRowLongPressMenu';
import type { UserConversation, UserStatus } from '@/types';
import { type CSSProperties } from 'react';

interface Props {
  conversation: UserConversation;
  hasUnread: boolean;
  // Alerted-unread count (see ChannelRow) — the numeric badge. DM messages
  // always alert unless the conversation is muted, so this usually tracks
  // the plain unread count; merely-unread shows the availability dot.
  notifyCount?: number;
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
  notifyCount = 0,
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
  // Mobile long-press opens the (otherwise hidden) row menu; shared with
  // the other sidebar row type so the behavior can't drift.
  const { menuOpen, setMenuOpen, rowHandlers, suppressNavClick } = useRowLongPressMenu();

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
      {...rowHandlers}
    >
      <NavLink
        to={`/conversation/${conversation.conversationID}`}
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
          `relative flex flex-1 min-w-0 items-center gap-2 rounded-md py-1.5 pl-2 pr-12 text-sm transition-colors mobile:h-12 mobile:py-0 mobile:pl-3 mobile:pr-20 mobile:text-base ${
            isActive
              ? 'bg-background text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
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
              className="h-5 w-5"
              dotSize={6}
            />
            <span className="truncate">{conversation.displayName}</span>
            <UserStatusIndicator status={dmUserStatus} className="h-4 w-4" />
          </>
        )}
        {/* Two-tier unread, mirroring ChannelRow: the brand-pink NUMBER counts
            only messages that alerted this user (DMs alert on every message
            unless muted); merely-unread activity is the availability dot.
            Absolutely positioned (flush to the edge, never reflows); fades on
            desktop hover so the row actions take its place, stays on touch at
            the VERY right edge (the kebab slot, unused on mobile) clear of
            the persistent star. */}
        {(hasUnread || notifyCount > 0) && (
          <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center transition-opacity group-hover/row:opacity-0 mobile:opacity-100">
            {notifyCount > 0 ? (
              <Badge variant="brand" className="text-[11px]" data-testid={`conversation-unread-badge-${conversation.conversationID}`}>
                {notifyCount > 99 ? '99+' : notifyCount}
              </Badge>
            ) : (
              <span
                aria-label="Unread"
                data-testid={`conversation-unread-dot-${conversation.conversationID}`}
                className="h-2 w-2 rounded-full bg-brand"
              />
            )}
          </span>
        )}
      </NavLink>
      {/* Star — visible on hover; persistent yellow when favorited.
          Positioned to match ChannelRow's right-7 / right-1 layout. */}
      <button
        onClick={toggleFavorite}
        aria-label={isFav ? `Unfavorite ${conversation.displayName}` : `Favorite ${conversation.displayName}`}
        data-testid={`conv-fav-toggle-${conversation.conversationID}`}
        className={`absolute right-7 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition-opacity mobile:right-10 mobile:h-9 mobile:w-9 ${
          isFav ? 'opacity-100 text-amber-300' : 'opacity-0 text-gray-400 hover:text-white group-hover/row:opacity-100 mobile:opacity-100'
        }`}
      >
        <Star className="h-3.5 w-3.5" fill={isFav ? 'currentColor' : 'none'} />
      </button>
      {/* Kebab — close only. Category placement is intentionally channel-only;
          DMs/groups move to Favorites through the star. Desktop: revealed on row
          hover. Mobile: the trigger is NOT a tap target (a long-press on the row
          opens it) but stays mounted + hidden so Radix can anchor the menu. */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          aria-label={`Manage ${conversation.displayName} sidebar placement`}
          data-testid={`conv-row-menu-${conversation.conversationID}`}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-gray-400 opacity-0 hover:bg-white/20 hover:text-white group-hover/row:opacity-100 mobile:pointer-events-none mobile:opacity-0"
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
