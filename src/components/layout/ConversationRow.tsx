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
  useCategories,
  useFavoriteConversation,
  useSetConversationCategory,
} from '@/hooks/useSidebar';
import { useRowLongPressMenu } from '@/hooks/useRowLongPressMenu';
import { useIsOnline } from '@/stores/presence';
import type { SidebarCategory, UserConversation, UserStatus } from '@/types';
import { memo, type CSSProperties } from 'react';

interface Props {
  conversation: UserConversation;
  hasUnread: boolean;
  // Replies in threads the user is in are unread: the row shows a dot.
  // Alerted-unread count (see ChannelRow) — the numeric badge. DM messages
  // always alert unless the conversation is muted, so this usually tracks
  // the plain unread count; merely-unread shows the availability dot.
  notifyCount?: number;
  dmAvatarURL?: string;
  dmUserStatus?: UserStatus;
  // The DM partner's user ID — the row subscribes to THAT user's presence
  // itself (per-row zustand selector), so a presence flip re-renders only
  // the affected row, not the whole sidebar. Unset for group rows: groups
  // render no availability dot.
  dmUserID?: string;
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
export const ConversationRow = memo(function ConversationRow({
  conversation,
  hasUnread,
  notifyCount = 0,
  dmAvatarURL,
  dmUserStatus,
  dmUserID,
  onClose,
  onHide,
  draggable,
  dragRef,
  dragStyle,
  suppressNavigation,
  onSuppressNavigationConsumed,
}: Props) {
  const partnerOnline = useIsOnline(dmUserID);
  // Groups (no dmUserID) must keep `undefined` — a boolean would render an
  // availability notch on the group avatar.
  const dmOnline = dmUserID ? partnerOnline : undefined;
  const favorite = useFavoriteConversation();
  const setCategory = useSetConversationCategory();
  const { data: categories } = useCategories();
  // Mobile long-press opens the (otherwise hidden) row menu; shared with
  // the other sidebar row type so the behavior can't drift.
  const { menuOpen, setMenuOpen, rowHandlers, suppressNavClick } = useRowLongPressMenu();

  const isFav = !!conversation.favorite;
  const isGroup = conversation.type === 'group';
  const participantCount = isGroup ? (conversation.participantIDs?.length ?? 0) : 0;

  // Like a channel: starring takes it out of its category; unstarring drops
  // its Favorites position and returns it to the category it kept (a drag
  // into Favorites keeps one), or to Direct Messages once that is deleted.
  function toggleFavorite(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (isFav) {
      const kept = (categories ?? []).some((c) => c.id === conversation.categoryID);
      setCategory.mutate({
        conversationID: conversation.conversationID,
        categoryID: kept ? conversation.categoryID! : '',
        sidebarPosition: 0,
      });
    } else if (conversation.categoryID) {
      setCategory.mutate({ conversationID: conversation.conversationID, categoryID: '' });
    }
    favorite.mutate({ conversationID: conversation.conversationID, favorite: !isFav });
  }

  function moveToCategory(categoryID: string) {
    if (isFav) {
      favorite.mutate({ conversationID: conversation.conversationID, favorite: false });
    }
    setCategory.mutate({ conversationID: conversation.conversationID, categoryID });
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
          `relative flex flex-1 min-w-0 items-center gap-2 rounded-md py-1.5 pl-2 pr-12 text-sm transition-colors touch:pr-16 mobile:h-12 mobile:py-0 mobile:pl-3 mobile:pr-20 mobile:text-base ${
            isActive
              ? 'bg-sidebar-accent text-white font-semibold before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:bg-sidebar-foreground before:content-[""]'
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
        {/* Three tiers, mirroring ChannelRow: the brand-pink NUMBER counts
            messages that alerted this user (DMs alert on every message
            unless muted); a dot means unread replies in a thread the user is
            in; plain new messages only embolden the name. Absolutely
            positioned (flush to the edge, never reflows); fades on desktop
            hover so the row actions take its place, stays on touch. On a
            phone the star sits flush right and the badge just left of it. */}
        {notifyCount > 0 && (
          <span className="pointer-events-none absolute right-2 top-1/2 flex -translate-y-1/2 items-center transition-opacity group-hover/row:opacity-0 touch:opacity-100 mobile:right-11">
            <Badge variant="brand" className="text-[11px]" data-testid={`conversation-unread-badge-${conversation.conversationID}`}>
              {notifyCount > 99 ? '99+' : notifyCount}
            </Badge>
          </span>
        )}
      </NavLink>
      {/* Star — visible on hover; a favorite keeps a quiet grey filled star
          that lifts on row hover (see ChannelRow). Positioned to match
          ChannelRow's right-7 / right-1 layout. */}
      <button
        onClick={toggleFavorite}
        aria-label={isFav ? `Unfavorite ${conversation.displayName}` : `Favorite ${conversation.displayName}`}
        data-testid={`conv-fav-toggle-${conversation.conversationID}`}
        className={`absolute right-7 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded transition-opacity touch:right-8 touch:h-7 touch:w-7 mobile:right-1 mobile:h-9 mobile:w-9 ${
          isFav
            ? 'opacity-100 text-gray-500 hover:text-white group-hover/row:text-gray-400'
            : 'opacity-0 text-gray-400 hover:text-white group-hover/row:opacity-100 touch:opacity-100'
        }`}
      >
        <Star className="h-3.5 w-3.5" fill={isFav ? 'currentColor' : 'none'} />
      </button>
      {/* Kebab — move to a category, or close. Desktop: revealed on row
          hover. Mobile: the trigger is NOT a tap target (a long-press on the row
          opens it) but stays mounted + hidden so Radix can anchor the menu. */}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          aria-label={`Manage ${conversation.displayName} sidebar placement`}
          data-testid={`conv-row-menu-${conversation.conversationID}`}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-gray-400 opacity-0 hover:bg-white/20 hover:text-white group-hover/row:opacity-100 touch:pointer-events-none touch:opacity-0"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            onClick={() => moveToCategory('')}
            disabled={!conversation.categoryID && !isFav}
          >
            Move to Direct Messages
          </DropdownMenuItem>
          {(categories ?? []).map((c: SidebarCategory) => (
            <DropdownMenuItem
              key={c.id}
              onClick={() => moveToCategory(c.id)}
              disabled={conversation.categoryID === c.id && !isFav}
            >
              Move to {c.name}
            </DropdownMenuItem>
          ))}
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
});
