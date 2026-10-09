import { memo, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AtSign,
  Bell,
  Bot,
  Check,
  CircleDot,
  Clock3,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  User as UserIcon,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { ChannelIcon } from '@/components/ChannelIcon';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { UserAvatar } from '@/components/UserAvatar';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRowLongPressMenu } from '@/hooks/useRowLongPressMenu';
import { activityTime, isWebhookItem, type ActivityRow } from '@/lib/activity-feed';
import type { User } from '@/types';

export interface ActivityChannelInfo {
  name: string;
  private: boolean;
}

export interface ActivityConversationInfo {
  name: string;
  group: boolean;
}

interface ActivityRowViewProps {
  row: ActivityRow;
  href: string;
  // The row's message is the page on screen.
  selected: boolean;
  actor: User | undefined;
  emojiMap: Record<string, string> | undefined;
  channel: ActivityChannelInfo | undefined;
  conversation: ActivityConversationInfo | undefined;
  onOpen: (row: ActivityRow) => void;
  onSetRead: (row: ActivityRow, read: boolean) => void;
  onRemove: (row: ActivityRow) => void;
}

const TYPE_ICON = {
  mention: AtSign,
  thread_reply: MessagesSquare,
  dm: MessageSquare,
  channel_added: UserPlus,
  reminder: Clock3,
} as const;

// ActivityRowView is one Activity row: a link to its message (opening it marks
// the row read), with Mark read/unread and Remove in a hover toolbar on a
// pointer device and on a long press on touch.
export const ActivityRowView = memo(function ActivityRowView({
  row,
  href,
  selected,
  actor,
  emojiMap,
  channel,
  conversation,
  onOpen,
  onSetRead,
  onRemove,
}: ActivityRowViewProps) {
  const item = row.lead;
  const unread = row.unreadIDs.length > 0;
  const webhook = isWebhookItem(item);
  const name = item.actorName || actor?.displayName || (item.type === 'reminder' ? 'Reminder' : 'Someone');
  // The lead's actor is named; count the other people who acted.
  const others = row.actorIDs.filter((id) => id !== item.actorID).length;
  // A type this client doesn't know yet still gets an icon.
  const TypeIcon = TYPE_ICON[item.type as keyof typeof TYPE_ICON] ?? AtSign;
  const { menuOpen, setMenuOpen, rowHandlers, suppressNavClick } = useRowLongPressMenu();

  const open = (event: MouseEvent) => {
    if (suppressNavClick()) {
      event.preventDefault();
      return;
    }
    onOpen(row);
  };
  // An unread row marks read; a read one marks unread.
  const toggleRead = () => onSetRead(row, unread);

  // pb-1: the list-row rhythm's 4px between rows (the virtual list can't use
  // space-y, so each row carries its own gap).
  return (
    <div className="pb-1">
      <div
        className={`group relative rounded-lg ${selected ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'}`}
        data-testid="activity-row"
        data-unread={unread ? 'true' : 'false'}
        {...rowHandlers}
      >
        <Link
          to={href}
          onClick={open}
          className="flex w-full gap-2.5 rounded-lg py-2 pr-2 pl-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          data-testid="activity-row-open"
        >
          {unread && (
            <>
              <span className="absolute top-5 left-1.5 h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" data-testid="activity-row-unread-dot" />
              <span className="sr-only">Unread:</span>
            </>
          )}
          <span className="relative mt-0.5 h-8 w-8 shrink-0 self-start">
            {item.type === 'reminder' || webhook ? (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                {webhook ? (
                  <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <Bell className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                )}
              </span>
            ) : (
              <UserAvatar displayName={name} avatarURL={actor?.avatarURL} className="h-8 w-8" />
            )}
            <span className="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full bg-sidebar" aria-hidden="true">
              {item.type === 'reaction' ? (
                <EmojiGlyph emoji={item.emoji ?? ''} customMap={emojiMap} size="sm" />
              ) : (
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-muted text-sidebar-foreground">
                  <TypeIcon className="h-2.5 w-2.5" strokeWidth={2.5} />
                </span>
              )}
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2">
              <span className={`min-w-0 flex-1 text-sm ${unread ? 'text-sidebar-foreground' : 'text-sidebar-foreground/85'}`}>
                <span className="font-semibold">{name}</span>
                {webhook && (
                  <span
                    className="ml-1 inline-block rounded bg-muted px-1 align-middle text-xs font-semibold uppercase leading-4 tracking-wide text-muted-foreground"
                    aria-label="Bot"
                    data-testid="activity-row-bot"
                  >
                    BOT
                  </span>
                )}
                {others > 0 && (
                  <>
                    {' '}and <span className="font-semibold">{others} {others === 1 ? 'other' : 'others'}</span>
                  </>
                )}{' '}
                {rowLabel(row, emojiMap)}
              </span>
              <span
                className={`shrink-0 text-xs text-muted-foreground ${menuOpen ? 'invisible' : 'group-hover:invisible group-has-focus-visible:invisible'}`}
              >
                {activityTime(item.createdAt)}
              </span>
            </span>
            <span className="mt-px flex items-center gap-1 text-xs text-muted-foreground">
              {item.parentType === 'conversation' ? (
                conversation?.group ? (
                  <>
                    <Users className="h-3 w-3" aria-hidden="true" />
                    {conversation.name}
                  </>
                ) : (
                  <>
                    <UserIcon className="h-3 w-3" aria-hidden="true" />
                    Direct message
                  </>
                )
              ) : (
                <>
                  {channel && <ChannelIcon type={channel.private ? 'private' : 'public'} className="h-3 w-3" ariaLabel="" />}
                  {channel?.name || item.parentName || item.channelSlug || 'channel'}
                </>
              )}
            </span>
            {item.messagePreview && (
              <span className={`mt-0.5 line-clamp-2 text-sm ${unread ? 'text-sidebar-foreground/90' : 'text-muted-foreground'}`}>
                {item.messagePreview}
              </span>
            )}
          </span>
        </Link>

        {/* Pointer devices reveal the actions on hover or keyboard focus. On
            touch they stay out of the way (a long press opens the menu), but
            stay mounted so the menu has its anchor. */}
        <div
          className={`absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md border border-sidebar-border bg-sidebar p-0.5 shadow-xs ${
            menuOpen
              ? 'opacity-100'
              : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:opacity-100'
          }`}
        >
          <TooltipIconButton label={unread ? 'Mark as read' : 'Mark as unread'} onClick={toggleRead} testId="activity-row-toggle-read">
            {unread ? <Check className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
          </TooltipIconButton>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger
              aria-label="More actions"
              data-testid="activity-row-more"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={toggleRead} data-testid="activity-menu-toggle-read">
                {unread ? <Check className="h-4 w-4" /> : <CircleDot className="h-4 w-4" />}
                {unread ? 'Mark as read' : 'Mark as unread'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRemove(row)} data-testid="activity-menu-remove">
                <X className="h-4 w-4" />
                Remove from activity
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
});

// What a row says after the actor's name.
function rowLabel(row: ActivityRow, emojiMap: Record<string, string> | undefined) {
  const item = row.lead;
  switch (item.type) {
    case 'reaction':
      return (
        <>
          reacted <EmojiGlyph emoji={item.emoji ?? ''} customMap={emojiMap} size="sm" />
        </>
      );
    case 'thread_reply':
      return 'replied in a thread';
    case 'dm':
      return row.items.length > 1 ? `sent you ${row.items.length} messages` : 'sent you a message';
    case 'channel_added':
      return `added you to ~${item.parentName || item.channelSlug || 'a channel'}`;
    case 'mention':
      if (item.mentionKind === 'all') return 'mentioned @all';
      if (item.mentionKind === 'here') return 'mentioned @here';
      if (item.mentionKind === 'keyword') return 'used one of your keywords';
      return 'mentioned you';
    default:
      // A reminder (or a type this client doesn't know) has nothing to add.
      return '';
  }
}
