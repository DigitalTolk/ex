import { useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AtSign,
  Bell,
  CheckCheck,
  Check,
  CircleDot,
  Clock3,
  Inbox,
  Lock,
  Hash,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Smile,
  User as UserIcon,
  UserPlus,
  X,
} from 'lucide-react';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { UserAvatar } from '@/components/UserAvatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  useActivity,
  useCancelReminder,
  useMarkActivityRead,
  useReminders,
  useRemoveActivity,
  useSetActivityRead,
} from '@/hooks/useActivity';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useEmojiMap } from '@/hooks/useEmoji';
import { useIsMobile } from '@/hooks/useIsMobile';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';
import { formatLongDateTime, slugify } from '@/lib/format';
import {
  ACTIVITY_FILTERS,
  activityDay,
  activityTime,
  groupActivity,
  matchesFilter,
  unreadForFilter,
  type ActivityDay,
  type ActivityFilter,
  type ActivityRow,
} from '@/lib/activity-groups';
import {
  selectActivityRow,
  setActivityFilter,
  setActivityUnreadOnly,
  useSidebarModeStore,
} from '@/stores/sidebar-mode';
import type { ActivityFeed, ActivityItem, Reminder, User } from '@/types';

interface ActivityPanelProps {
  // Called after an item opens, so a drawer or overlay can close itself.
  onNavigate?: () => void;
}

// ActivityPanel is the Activity list that replaces the channel list when the
// sidebar is on Activity: filter tabs with unread dots, an "Unread only"
// switch, mark-all-read, and the rows grouped by day. Opening a row shows the
// message in its channel, DM or thread and marks the row read.
export function ActivityPanel({ onNavigate }: ActivityPanelProps) {
  const { data: feed, isLoading } = useActivity();
  const { data: reminders } = useReminders();
  const { data: channels } = useUserChannels();
  const { data: conversations } = useUserConversations();
  const { data: emojiMap } = useEmojiMap();
  const filter = useSidebarModeStore((s) => s.filter);
  const unreadOnly = useSidebarModeStore((s) => s.unreadOnly);
  const selectedKey = useSidebarModeStore((s) => s.selectedKey);
  const markAllRead = useMarkActivityRead();
  const setRead = useSetActivityRead();
  const remove = useRemoveActivity();
  const cancelReminder = useCancelReminder();
  const navigate = useNavigate();

  const items = useMemo(() => feed?.items ?? [], [feed]);
  const rows = useMemo(() => {
    const visible = items.filter((i) => matchesFilter(i.type, filter));
    return groupActivity(visible).filter((r) => !unreadOnly || r.unread || r.key === selectedKey);
  }, [items, filter, unreadOnly, selectedKey]);

  const actorIDs = useMemo(
    () => items.filter((i) => i.actorID && !i.actorName).map((i) => i.actorID as string),
    [items],
  );
  const { map: users } = useUsersBatch(actorIDs);

  const channelByID = useMemo(() => {
    const m = new Map<string, { slug: string; name: string; private: boolean }>();
    for (const c of channels ?? []) {
      m.set(c.channelID, { slug: slugify(c.channelName), name: c.channelName, private: c.channelType === 'private' });
    }
    return m;
  }, [channels]);
  const conversationNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of conversations ?? []) m.set(c.conversationID, c.displayName);
    return m;
  }, [conversations]);

  const hrefFor = (i: ActivityItem | Reminder) => {
    // A row about a thread reply links with its thread root so the thread
    // opens on it.
    if (i.parentType !== 'channel') return buildConversationHref(i.parentID, i.messageID, i.parentMessageID);
    const slug = i.channelSlug || channelByID.get(i.parentID)?.slug || i.parentID;
    return buildChannelHref(slug, i.messageID, i.parentMessageID);
  };

  const open = (row: ActivityRow) => {
    selectActivityRow(row.key);
    if (row.unread) setRead.mutate({ ids: row.ids, read: true });
    navigate(hrefFor(row.latest));
    onNavigate?.();
  };

  const pending = filter === 'all' ? (reminders ?? []) : [];
  const unread = feed?.unread ?? 0;

  // Rows in order, with a heading each time the day changes.
  const sections: { day: ActivityDay; rows: ActivityRow[] }[] = [];
  for (const row of rows) {
    const day = activityDay(row.latest.createdAt);
    const last = sections[sections.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else sections.push({ day, rows: [row] });
  }

  const isMobile = useIsMobile();

  return (
    <div className="flex h-full min-h-0 flex-col text-sidebar-foreground" data-testid="activity-panel">
      <div className="shrink-0 px-2">
        <FilterTabs filter={filter} feed={feed} />
        {/* On a phone the row gets more room around it and a full-height
            touch target for the toggle. */}
        <div className="flex items-center justify-between pt-3 pb-2 pl-1">
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-muted-foreground mobile:min-h-11 mobile:gap-3 mobile:pr-4 mobile:text-sm">
            <Switch
              size={isMobile ? 'default' : 'sm'}
              checked={unreadOnly}
              onCheckedChange={(on) => setActivityUnreadOnly(on)}
              data-testid="activity-unread-only"
            />
            Unread only
          </label>
          <TooltipIconButton
            label="Mark all as read"
            onClick={() => markAllRead.mutate()}
            disabled={unread === 0}
            className="text-muted-foreground mobile:size-11"
            testId="activity-mark-all-read"
          >
            <CheckCheck className="h-4 w-4" />
          </TooltipIconButton>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" data-testid="activity-scroll-area">
        <div className="px-2 pb-3">
          {pending.length > 0 && (
            <section data-testid="pending-reminders" className="pb-1">
              <h3 className="px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground">Scheduled reminders</h3>
              {pending.map((r) => (
                <div key={r.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sidebar-accent/60" data-testid="pending-reminder">
                  <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    onClick={() => {
                      navigate(hrefFor(r));
                      onNavigate?.();
                    }}
                  >
                    {r.messagePreview || 'A message'}
                  </button>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatLongDateTime(r.remindAt)}</span>
                  <TooltipIconButton label="Cancel reminder" onClick={() => cancelReminder.mutate(r.id)} testId="cancel-reminder">
                    <X className="h-3.5 w-3.5" />
                  </TooltipIconButton>
                </div>
              ))}
            </section>
          )}

          {isLoading && (
            <div className="space-y-2 pt-3" data-testid="activity-loading">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          )}

          {!isLoading && rows.length === 0 && (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground" data-testid="activity-empty">
              <Inbox className="mx-auto mb-2 h-8 w-8 opacity-60" aria-hidden="true" />
              <p className="font-medium text-sidebar-foreground">You’re all caught up</p>
              <p>{unreadOnly ? 'Nothing unread here.' : 'Nothing here yet.'}</p>
            </div>
          )}

          {sections.map((section) => (
            <section key={section.day}>
              <h3 className="px-2 pt-3 pb-1 text-xs font-semibold text-muted-foreground">{section.day}</h3>
              {section.rows.map((row) => (
                <Row
                  key={row.key}
                  row={row}
                  selected={row.key === selectedKey}
                  users={users}
                  emojiMap={emojiMap}
                  channel={channelByID.get(row.latest.parentID)}
                  conversationName={conversationNames.get(row.latest.parentID)}
                  onOpen={() => open(row)}
                  onToggleRead={() => setRead.mutate({ ids: row.ids, read: row.unread })}
                  onRemove={() => remove.mutate(row.ids)}
                />
              ))}
            </section>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

const FILTER_ICON: Record<ActivityFilter, ComponentType<{ className?: string }>> = {
  all: Inbox,
  dms: MessageSquare,
  mentions: AtSign,
  threads: MessagesSquare,
  reactions: Smile,
};

// The filter tabs. Only the selected tab shows its label; the others are
// just their icon. Switching animates both ends at once on the same curve:
// the old label closes while the new one opens, each to its real width, so
// the new tab grows into the space the old one gives up instead of jumping.
// The underline does the same — it retracts toward the new tab and grows in
// from the old one's side — so it reads as one line sliding across.
function FilterTabs({ filter, feed }: { filter: ActivityFilter; feed: ActivityFeed | undefined }) {
  const index = ACTIVITY_FILTERS.findIndex((f) => f.key === filter);
  // Where the selection came from, kept per render so each tab knows which
  // side to animate from. Set during render (not in an effect) so the very
  // render that changes the filter already sees the previous one.
  const [last, setLast] = useState({ filter, from: index });
  if (last.filter !== filter) setLast({ filter, from: ACTIVITY_FILTERS.findIndex((f) => f.key === last.filter) });
  const from = last.from;

  return (
    <div
      role="tablist"
      aria-label="Activity filters"
      // On a phone every tab shows its label, spread across the width; a
      // very narrow screen scrolls sideways rather than clipping one.
      className="flex gap-2 border-b border-sidebar-border mobile:justify-between mobile:gap-0 mobile:overflow-x-auto mobile:[scrollbar-width:none] mobile:[&::-webkit-scrollbar]:hidden"
    >
      {ACTIVITY_FILTERS.map((f, i) => {
        // The underline's anchor: an opening tab grows from the side the
        // selection came from; a closing tab shrinks toward the new one.
        const toward = i === index ? (from < i ? 'left' : 'right') : index > i ? 'right' : 'left';
        return (
          <FilterTab
            key={f.key}
            filter={f.key}
            label={f.label}
            active={i === index}
            anchor={toward}
            unread={feed ? unreadForFilter(feed, f.key) : 0}
          />
        );
      })}
    </div>
  );
}

const EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

function FilterTab({
  filter,
  label,
  active,
  anchor,
  unread,
}: {
  filter: ActivityFilter;
  label: string;
  active: boolean;
  anchor: 'left' | 'right';
  unread: number;
}) {
  const Icon = FILTER_ICON[filter];
  // On a phone every tab keeps its label; elsewhere only the selected one.
  const isMobile = useIsMobile();
  const expanded = active || isMobile;
  // The label's natural width, so open and close animate real pixels (a
  // max-width trick would run the two at different speeds).
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelWidth, setLabelWidth] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setLabelWidth(labelRef.current!.scrollWidth);
    measure();
    // Re-measure once the web font has loaded; the fallback face is wider.
    let live = true;
    void document.fonts?.ready.then(() => {
      /* istanbul ignore else -- only false when the tab unmounts before the font promise settles, a race no test can pin deterministically */
      if (live) measure();
    });
    return () => {
      live = false;
    };
  }, [label]);

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={expanded ? undefined : label}
      onClick={() => setActivityFilter(filter)}
      className={`relative flex h-9 shrink-0 items-center px-1.5 mobile:px-1 text-[13px] font-medium outline-none transition-colors duration-300 focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none ${
        active ? 'text-sidebar-foreground' : 'text-muted-foreground/70 hover:text-muted-foreground'
      }`}
      data-testid={`activity-filter-${filter}`}
    >
      <span className="relative shrink-0">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {filter !== 'all' && unread > 0 && (
          <span
            className="absolute -top-0.5 -right-1 h-1.5 w-1.5 rounded-full bg-brand ring-2 ring-sidebar"
            aria-hidden="true"
            data-testid={`activity-filter-${filter}-dot`}
          />
        )}
      </span>
      <span
        className="overflow-hidden whitespace-nowrap motion-reduce:transition-none"
        style={{
          width: expanded ? labelWidth : 0,
          marginLeft: expanded ? (isMobile ? 4 : 6) : 0,
          opacity: expanded ? 1 : 0,
          transition: `width 300ms ${EASE}, margin-left 300ms ${EASE}, opacity 200ms ${EASE}`,
        }}
        aria-hidden="true"
      >
        <span ref={labelRef} className="inline-block">
          {label}
        </span>
      </span>
      <span
        className="pointer-events-none absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-sidebar-foreground motion-reduce:transition-none"
        style={{
          transform: active ? 'scaleX(1)' : 'scaleX(0)',
          transformOrigin: anchor,
          transition: `transform 300ms ${EASE}`,
        }}
        aria-hidden="true"
      />
    </button>
  );
}

const TYPE_ICON = {
  mention: AtSign,
  thread_reply: MessagesSquare,
  dm: MessageSquare,
  channel_added: UserPlus,
  reminder: Clock3,
} as const;

interface RowProps {
  row: ActivityRow;
  selected: boolean;
  users: Map<string, User>;
  emojiMap: Record<string, string> | undefined;
  channel: { name: string; private: boolean } | undefined;
  conversationName: string | undefined;
  onOpen: () => void;
  onToggleRead: () => void;
  onRemove: () => void;
}

function Row({ row, selected, users, emojiMap, channel, conversationName, onOpen, onToggleRead, onRemove }: RowProps) {
  const item = row.latest;
  const actor = item.actorID ? users.get(item.actorID) : undefined;
  const name = item.actorName || actor?.displayName || (item.type === 'reminder' ? 'Reminder' : 'Someone');
  const others = row.actorIDs.length - 1;
  // A type this client doesn't know yet still gets an icon.
  const TypeIcon = TYPE_ICON[item.type as keyof typeof TYPE_ICON] ?? AtSign;
  // Keep the hover actions showing while the More menu is open.
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={`group relative rounded-lg ${selected ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60'}`}
      data-testid="activity-row"
      data-unread={row.unread ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full gap-2.5 rounded-lg py-2 pr-2 pl-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-testid="activity-row-open"
      >
        {row.unread && (
          <span className="absolute top-[22px] left-1.5 h-1.5 w-1.5 rounded-full bg-brand" aria-label="Unread" data-testid="activity-row-unread-dot" />
        )}
        <span className="relative mt-0.5 h-8 w-8 shrink-0 self-start">
          {item.type === 'reminder' ? (
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
              <Bell className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </span>
          ) : (
            <UserAvatar displayName={name} avatarURL={actor?.avatarURL} className="h-8 w-8" />
          )}
          <span className="absolute -right-1 -bottom-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-sidebar" aria-hidden="true">
            {item.type === 'reaction' ? (
              <EmojiGlyph emoji={item.emoji ?? ''} customMap={emojiMap} size="sm" />
            ) : (
              <span className={`flex h-4 w-4 items-center justify-center rounded-full ${item.type === 'mention' ? 'bg-brand text-white' : 'bg-muted text-sidebar-foreground'}`}>
                <TypeIcon className="h-2.5 w-2.5" strokeWidth={2.5} />
              </span>
            )}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={`min-w-0 flex-1 text-[13.5px] ${row.unread ? 'text-sidebar-foreground' : 'text-sidebar-foreground/85'}`}>
              <span className="font-semibold">{name}</span>
              {others > 0 && (
                <>
                  {' '}and <span className="font-semibold">{others} {others === 1 ? 'other' : 'others'}</span>
                </>
              )}{' '}
              {rowLabel(row, emojiMap)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground group-hover:invisible group-focus-within:invisible">{activityTime(item.createdAt)}</span>
          </span>
          <span className="mt-px flex items-center gap-1 text-xs text-muted-foreground">
            {item.parentType === 'conversation' ? (
              <>
                <UserIcon className="h-3 w-3" aria-hidden="true" />
                {conversationName && row.latest.type !== 'dm' ? conversationName : 'Direct message'}
              </>
            ) : (
              <>
                {channel?.private ? <Lock className="h-3 w-3" aria-hidden="true" /> : <Hash className="h-3 w-3" aria-hidden="true" />}
                {channel?.name || item.parentName || item.channelSlug || 'channel'}
              </>
            )}
          </span>
          {item.messagePreview && (
            <span className={`mt-0.5 line-clamp-2 text-[13px] ${row.unread ? 'text-sidebar-foreground/90' : 'text-muted-foreground'}`}>
              {item.messagePreview}
            </span>
          )}
        </span>
      </button>

      <div className={`absolute top-1.5 right-1.5 items-center gap-0.5 rounded-md border border-sidebar-border bg-sidebar p-0.5 shadow-xs ${menuOpen ? 'flex' : 'hidden group-hover:flex group-focus-within:flex touch:flex'}`}>
        <TooltipIconButton label={row.unread ? 'Mark as read' : 'Mark as unread'} onClick={onToggleRead} testId="activity-row-toggle-read">
          {row.unread ? <Check className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
        </TooltipIconButton>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger aria-label="More actions" data-testid="activity-row-more" className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onClick={onToggleRead} data-testid="activity-menu-toggle-read">
              {row.unread ? <Check className="h-4 w-4" /> : <CircleDot className="h-4 w-4" />}
              {row.unread ? 'Mark as read' : 'Mark as unread'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRemove} data-testid="activity-menu-remove">
              <X className="h-4 w-4" />
              Remove from activity
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// What a row says after the actor's name.
function rowLabel(row: ActivityRow, emojiMap: Record<string, string> | undefined) {
  const item = row.latest;
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
      return row.count > 1 ? `sent you ${row.count} messages` : 'sent you a message';
    case 'channel_added':
      return `added you to #${item.parentName || item.channelSlug || 'a channel'}`;
    case 'reminder':
      return '';
    default:
      if (item.mentionKind === 'all') return 'mentioned @all';
      if (item.mentionKind === 'here') return 'mentioned @here';
      if (item.mentionKind === 'keyword') return 'used one of your keywords';
      return 'mentioned you';
  }
}
