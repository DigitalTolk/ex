import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Virtuoso } from 'react-virtuoso';
import {
  AtSign,
  Bell,
  CheckCheck,
  Clock3,
  MailOpen,
  Mail,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { PageContainer } from '@/components/layout/PageContainer';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmojiGlyph } from '@/components/EmojiGlyph';
import { UserHoverCard } from '@/components/UserHoverCard';
import {
  useActivity,
  useCancelReminder,
  useMarkActivityRead,
  useReminders,
  useRemoveActivityItems,
  useSetActivityItemsRead,
} from '@/hooks/useActivity';
import { useUserChannels } from '@/hooks/useChannels';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useEmojiMap } from '@/hooks/useEmoji';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useAuth } from '@/context/AuthContext';
import { buildChannelHref, buildConversationHref } from '@/lib/message-deeplink';
import { formatLongDateTime, formatRelative, slugify } from '@/lib/format';
import {
  ACTIVITY_TABS,
  filterActivity,
  groupActivity,
  parseActivityTab,
  tabHasUnread,
  type ActivityRow,
} from '@/lib/activity-feed';
import type { ActivityItem, Reminder, User } from '@/types';

// What a row says after the actor's name. count > 1 for a grouped row.
function actorLabel(item: ActivityItem, count: number): string {
  switch (item.type) {
    case 'reaction':
      return 'reacted to your message';
    case 'thread_reply':
      return count > 1 ? `replied in a thread (${count})` : 'replied in a thread';
    case 'dm':
      return count > 1 ? `sent you messages (${count})` : 'sent you a message';
    case 'channel_added':
      return `added you to ~${item.parentName || item.channelSlug || 'a channel'}`;
    default:
      if (item.mentionKind === 'all') return 'mentioned @all';
      if (item.mentionKind === 'here') return 'mentioned @here';
      if (item.mentionKind === 'keyword') return 'used one of your keywords';
      return 'mentioned you';
  }
}

// The icon for rows that aren't reactions (a reaction shows its emoji).
function ActivityIcon({ type }: { type: ActivityItem['type'] }) {
  if (type === 'reminder') return <Bell className="h-4 w-4 text-pinned" aria-hidden="true" />;
  const Icon =
    type === 'thread_reply' ? MessagesSquare : type === 'dm' ? MessageSquare : type === 'channel_added' ? UserPlus : AtSign;
  return <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
}

interface RowProps {
  row: ActivityRow;
  href: string;
  actor: User | undefined;
  emojiMap: Record<string, string> | undefined;
  currentUserId: string | undefined;
  onOpen: (row: ActivityRow) => void;
  onSetRead: (row: ActivityRow, read: boolean) => void;
  onRemove: (row: ActivityRow) => void;
}

function ActivityRowView({ row, href, actor, emojiMap, currentUserId, onOpen, onSetRead, onRemove }: RowProps) {
  const item = row.lead;
  const unread = row.unreadIDs.length > 0;
  const name = item.actorName || actor?.displayName || 'Someone';
  const fallback = item.type === 'channel_added' ? 'Open channel' : 'View message';
  return (
    // The row holds a hover card, a link and a menu, so it can't itself be one
    // anchor (interactive elements can't nest in an <a>).
    <div className="pb-2">
      <div
        className="relative flex items-start gap-3 rounded-lg border border-border bg-card p-3"
        data-testid="activity-item"
        data-unread={unread || undefined}
      >
        {unread && (
          <span
            className="absolute left-1 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-brand"
            data-testid="activity-unread-dot"
            aria-hidden="true"
          />
        )}
        <span className="mt-0.5 flex w-5 shrink-0 justify-center">
          {item.type === 'reaction' ? (
            <EmojiGlyph emoji={item.emoji ?? ''} customMap={emojiMap} size="lg" />
          ) : (
            <ActivityIcon type={item.type} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className={`line-clamp-2 block text-sm ${unread ? 'font-semibold' : ''}`}>
            {unread && <span className="sr-only">Unread:</span>}
            {item.type === 'reminder' ? (
              <span className="font-semibold">Reminder</span>
            ) : (
              <>
                {item.actorID && !item.actorName && !item.webhook ? (
                  <UserHoverCard
                    userId={item.actorID}
                    displayName={name}
                    avatarURL={actor?.avatarURL}
                    userStatus={actor?.userStatus}
                    online={actor?.online}
                    currentUserId={currentUserId}
                    triggerClassName="font-semibold cursor-pointer"
                  >
                    {name}
                  </UserHoverCard>
                ) : (
                  <span className="font-semibold">{name}</span>
                )}
                {item.webhook && (
                  <span
                    className="ml-1 inline-block rounded bg-muted px-1 align-middle text-[10px] font-semibold uppercase leading-4 tracking-wide text-muted-foreground"
                    aria-label="Bot"
                  >
                    BOT
                  </span>
                )}{' '}
                {actorLabel(item, row.items.length)}
              </>
            )}
          </span>
          <Link
            to={href}
            onClick={() => onOpen(row)}
            className="mt-0.5 block truncate text-sm text-muted-foreground transition-colors hover:text-foreground"
            data-testid="activity-link"
          >
            {item.messagePreview || fallback}
          </Link>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatRelative(item.createdAt)}</span>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            aria-label="Activity actions"
            data-testid="activity-actions"
            className="-my-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {unread ? (
              <DropdownMenuItem onClick={() => onSetRead(row, true)}>
                <MailOpen className="mr-2 h-4 w-4" />
                Mark as read
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onSetRead(row, false)}>
                <Mail className="mr-2 h-4 w-4" />
                Mark as unread
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onRemove(row)}>
              <Trash2 className="mr-2 h-4 w-4" />
              Remove from activity
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export default function ActivityPage() {
  useDocumentTitle('Activity');
  const [params, setParams] = useSearchParams();
  const tab = parseActivityTab(params.get('tab'));
  const { data: feed, isLoading } = useActivity();
  const { data: reminders } = useReminders();
  const { data: channels } = useUserChannels();
  const markAllRead = useMarkActivityRead();
  const setItemsRead = useSetActivityItemsRead();
  const removeItems = useRemoveActivityItems();
  const cancelReminder = useCancelReminder();
  const { data: emojiMap } = useEmojiMap();
  const { user } = useAuth();

  const items = useMemo(() => feed?.items ?? [], [feed]);
  const allRows = useMemo(() => groupActivity(items), [items]);
  const rows = useMemo(() => (tab === 'all' ? allRows : groupActivity(filterActivity(items, tab))), [allRows, items, tab]);

  // Resolve the displayed actors' names in one go (useUsersBatch splits the
  // request into the server's 100-id batches). Every tab's rows are a subset of
  // All's, so All's leads cover them.
  const actorIDs = useMemo(
    () =>
      allRows
        .map((r) => r.lead)
        .filter((i) => i.actorID && !i.actorName && !i.webhook)
        .map((i) => i.actorID as string),
    [allRows],
  );
  const { map: userMap } = useUsersBatch(actorIDs);

  // channelID → slug, built once from the channel cache so each row's deep link
  // is an O(1) lookup instead of a linear scan per render.
  const channelSlugByID = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of channels ?? []) m.set(c.channelID, slugify(c.channelName));
    return m;
  }, [channels]);

  // A row about a thread reply links with its thread root so the thread opens
  // on it — replies never render in the main list.
  const hrefFor = (i: ActivityItem | Reminder) => {
    if (i.parentType !== 'channel') return buildConversationHref(i.parentID, i.messageID, i.parentMessageID);
    // Prefer the item's own slug snapshot, else the channel cache, else the id.
    const slug = i.channelSlug || channelSlugByID.get(i.parentID) || i.parentID;
    return buildChannelHref(slug, i.messageID, i.parentMessageID);
  };

  const setReadMutate = setItemsRead.mutate;
  const removeMutate = removeItems.mutate;
  // Opening a row reads it. Mentions, DMs and replies would also read once the
  // message is on screen; reactions, reminders and channel adds only read here.
  const onOpen = useCallback(
    (row: ActivityRow) => {
      if (row.unreadIDs.length > 0) setReadMutate({ ids: row.unreadIDs, read: true });
    },
    [setReadMutate],
  );
  const onSetRead = useCallback(
    (row: ActivityRow, read: boolean) => setReadMutate({ ids: row.items.map((i) => i.id), read }),
    [setReadMutate],
  );
  const onRemove = useCallback((row: ActivityRow) => removeMutate(row.items.map((i) => i.id)), [removeMutate]);

  // The list scrolls with the page, so the virtualized list tracks the page's
  // scroll container instead of owning one.
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const listRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setScrollParent(el.closest<HTMLElement>('[data-page-scroll]'));
  }, []);

  const pending = tab === 'all' ? (reminders ?? []) : [];
  const unread = feed?.unread ?? 0;

  return (
    <PageContainer
      title="Activity"
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={unread === 0}
          onClick={() => markAllRead.mutate()}
          data-testid="activity-mark-all-read"
        >
          <CheckCheck className="mr-1.5 h-4 w-4" aria-hidden="true" />
          Mark all as read
        </Button>
      }
    >
      <div role="tablist" aria-label="Activity filters" className="-mx-1 flex gap-1 overflow-x-auto border-b px-1">
        {ACTIVITY_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams(t.id === 'all' ? {} : { tab: t.id }, { replace: true })}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-2 text-sm font-medium sm:px-3 ${
              tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            {feed && tabHasUnread(feed, t.id) && (
              <>
                <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" data-testid={`activity-tab-unread-${t.id}`} />
                <span className="sr-only">(unread)</span>
              </>
            )}
          </button>
        ))}
      </div>

      {pending.length > 0 && (
        <section data-testid="pending-reminders">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Scheduled reminders
          </h2>
          <div className="space-y-2">
            {pending.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
                data-testid="pending-reminder"
              >
                <Clock3 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <Link
                  to={hrefFor(r)}
                  className="min-w-0 flex-1 truncate text-sm transition-colors hover:text-muted-foreground"
                >
                  {r.messagePreview || 'A message'}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatLongDateTime(r.remindAt)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Cancel reminder"
                  data-testid="cancel-reminder"
                  onClick={() => cancelReminder.mutate(r.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {isLoading && (
        <div className="space-y-3" data-testid="activity-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {!isLoading && rows.length === 0 && (
        <p className="py-12 text-center text-muted-foreground" data-testid="activity-empty">
          No activity yet.
        </p>
      )}

      <div ref={listRef} data-testid="activity-list">
        {scrollParent && rows.length > 0 && (
          <Virtuoso
            customScrollParent={scrollParent}
            data={rows}
            computeItemKey={(_, row) => row.key}
            increaseViewportBy={400}
            itemContent={(_, row) => (
              <ActivityRowView
                row={row}
                href={hrefFor(row.lead)}
                actor={userMap.get(row.lead.actorID ?? '')}
                emojiMap={emojiMap}
                currentUserId={user?.id}
                onOpen={onOpen}
                onSetRead={onSetRead}
                onRemove={onRemove}
              />
            )}
          />
        )}
      </div>
    </PageContainer>
  );
}
