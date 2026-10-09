import { memo, useCallback, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { GroupedVirtuoso } from 'react-virtuoso';
import { CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import {
  useActivity,
  useMarkActivityRead,
  useReminders,
  useRemoveActivityItems,
  useSetActivityItemsRead,
} from '@/hooks/useActivity';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useUsersBatch } from '@/hooks/useUsersBatch';
import { useEmojiMap } from '@/hooks/useEmoji';
import { useIsMobile } from '@/hooks/useIsMobile';
import { slugify } from '@/lib/format';
import {
  ACTIVITY_TABS,
  activityHref,
  activitySections,
  filterActivity,
  groupActivity,
  isWebhookItem,
  tabUnread,
  type ActivityRow,
  type ActivityTab,
} from '@/lib/activity-feed';
import { selectActivityRow, setActivityUnreadOnly, useSidebarModeStore } from '@/stores/sidebar-mode';
import type { Reminder, UserChannel, UserConversation } from '@/types';
import { ActivityFilterTabs } from './ActivityFilterTabs';
import { ActivityRowView, type ActivityChannelInfo, type ActivityConversationInfo } from './ActivityRow';
import { PendingReminders } from './PendingReminders';

// Only what the rows show, so an unread bump on a channel or DM (a new list
// array every message) doesn't re-render the panel: structural sharing keeps
// these selections' references while names and types are unchanged.
const selectChannels = (rows: UserChannel[]) =>
  rows.map((c) => ({ id: c.channelID, name: c.channelName, private: c.channelType === 'private' }));
const selectConversations = (rows: UserConversation[]) =>
  rows.map((c) => ({ id: c.conversationID, name: c.displayName, group: c.type === 'group' }));

function pathOf(href: string): string {
  return href.split(/[?#]/)[0];
}

interface ActivityPanelProps {
  // Called after an item opens, so a drawer or overlay can close itself.
  onNavigate?: () => void;
}

// ActivityPanel is the Activity list that replaces the channel list when the
// sidebar is on Activity: filter tabs with unread dots, an "Unread only"
// switch, mark-all-read for the tab, and the rows grouped by day. Opening a
// row shows the message in its channel, DM or thread and marks the row read.
export const ActivityPanel = memo(function ActivityPanel({ onNavigate }: ActivityPanelProps) {
  const { data: feed, isLoading, isError, refetch } = useActivity();
  const { data: reminders } = useReminders();
  const { data: channels } = useUserChannels({ select: selectChannels });
  const { data: conversations } = useUserConversations({ select: selectConversations });
  const { data: emojiMap } = useEmojiMap();
  const filter = useSidebarModeStore((s) => s.filter);
  const unreadOnly = useSidebarModeStore((s) => s.unreadOnly);
  const selectedKey = useSidebarModeStore((s) => s.selectedKey);
  const markAllRead = useMarkActivityRead();
  const setItemsRead = useSetActivityItemsRead();
  const removeItems = useRemoveActivityItems();
  const location = useLocation();
  const isMobile = useIsMobile();

  const channelByID = useMemo(() => {
    const m = new Map<string, ActivityChannelInfo>();
    for (const c of channels ?? []) m.set(c.id, c);
    return m;
  }, [channels]);
  const slugByChannelID = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of channels ?? []) m.set(c.id, slugify(c.name));
    return m;
  }, [channels]);
  const conversationByID = useMemo(() => {
    const m = new Map<string, ActivityConversationInfo>();
    for (const c of conversations ?? []) m.set(c.id, c);
    return m;
  }, [conversations]);

  const items = useMemo(() => feed?.items ?? [], [feed]);
  const allRows = useMemo(() => groupActivity(items), [items]);
  const tabRows = useMemo(
    () => (filter === 'all' ? allRows : groupActivity(filterActivity(items, filter))),
    [allRows, items, filter],
  );
  const hrefFor = useCallback((i: Reminder | ActivityRow['lead']) => activityHref(i, slugByChannelID), [slugByChannelID]);

  // The opened row stays highlighted — and listed under "Unread only" — while
  // its message is the page on screen; going anywhere else lets it go.
  const selectedRow = tabRows.find((r) => r.key === selectedKey);
  const activeKey = selectedRow && pathOf(hrefFor(selectedRow.lead)) === location.pathname ? selectedRow.key : null;
  const rows = useMemo(
    () => (unreadOnly ? tabRows.filter((r) => r.unreadIDs.length > 0 || r.key === activeKey) : tabRows),
    [tabRows, unreadOnly, activeKey],
  );
  const sections = useMemo(() => activitySections(rows), [rows]);
  const groupCounts = useMemo(() => sections.map((s) => s.rows.length), [sections]);
  // The virtual list keys its day headings and rows as one run.
  const listKeys = useMemo(() => sections.flatMap((s) => [`day:${s.day}`, ...s.rows.map((r) => r.key)]), [sections]);

  // Names for the people the rows name (each row names its newest actor).
  const actorIDs = useMemo(
    () => allRows.flatMap((r) => (r.lead.actorID && !isWebhookItem(r.lead) ? [r.lead.actorID] : [])),
    [allRows],
  );
  const { map: users } = useUsersBatch(actorIDs);

  const unreadByTab = useMemo(() => {
    const out = {} as Record<ActivityTab, number>;
    for (const t of ACTIVITY_TABS) out[t.id] = feed ? tabUnread(feed, t.id) : 0;
    return out;
  }, [feed]);

  const setRead = setItemsRead.mutate;
  const remove = removeItems.mutate;
  const onOpen = useCallback(
    (row: ActivityRow) => {
      selectActivityRow(row.key);
      if (row.unreadIDs.length > 0) setRead({ ids: row.unreadIDs, read: true });
      onNavigate?.();
    },
    [setRead, onNavigate],
  );
  // Marking a row unread marks its newest item, so the row reads unread
  // without counting every message in a busy conversation again.
  const onSetRead = useCallback(
    (row: ActivityRow, read: boolean) => setRead({ ids: read ? row.unreadIDs : [row.lead.id], read }),
    [setRead],
  );
  const onRemove = useCallback((row: ActivityRow) => remove(row.items.map((i) => i.id)), [remove]);

  // "Mark all as read" covers the tab on screen: All advances the read
  // watermark; another tab marks just its own unread items, leaving the rest
  // (and anything deliberately marked unread elsewhere) alone.
  const markTabRead = () => {
    if (filter === 'all') markAllRead.mutate();
    else setRead({ ids: filterActivity(items, filter).filter((i) => !i.read).map((i) => i.id), read: true });
  };

  // The rows scroll with the panel's scroll area, so the virtual list tracks
  // that viewport instead of owning a scroller.
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const listRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setScrollParent(el.closest<HTMLElement>('[data-slot="scroll-area-viewport"]'));
  }, []);

  const pending = filter === 'all' ? (reminders ?? []) : [];

  return (
    <div className="flex h-full min-h-0 flex-col text-sidebar-foreground" data-testid="activity-panel">
      <div className="shrink-0 px-2">
        <ActivityFilterTabs filter={filter} unread={unreadByTab} />
        <div className="flex items-center justify-between pt-3 pb-2 pl-1">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground mobile:min-h-11 mobile:gap-3 mobile:pr-4">
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
            onClick={markTabRead}
            disabled={unreadByTab[filter] === 0}
            className="text-muted-foreground mobile:size-11"
            testId="activity-mark-all-read"
          >
            <CheckCheck className="h-4 w-4" />
          </TooltipIconButton>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1" data-testid="activity-scroll-area">
        <div className="px-2 pb-3">
          {pending.length > 0 && <PendingReminders reminders={pending} hrefFor={hrefFor} onNavigate={onNavigate} />}

          {isLoading && (
            <div className="space-y-2 pt-3" data-testid="activity-loading">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          )}

          {isError && !feed && (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-sm text-muted-foreground" data-testid="activity-error">
              <p>Couldn’t load activity</p>
              <Button variant="outline" size="sm" onClick={() => void refetch()}>
                Try again
              </Button>
            </div>
          )}

          {feed && rows.length === 0 && (
            <p className="px-6 py-12 text-center text-sm text-muted-foreground" data-testid="activity-empty">
              {unreadOnly ? 'No unread activity' : 'No activity'}
            </p>
          )}

          <div ref={listRef}>
            {scrollParent && rows.length > 0 && (
              <GroupedVirtuoso
                customScrollParent={scrollParent}
                groupCounts={groupCounts}
                increaseViewportBy={400}
                computeItemKey={(index) => listKeys[index]}
                groupContent={(index) => (
                  <h3 className="bg-sidebar px-2 pt-3 pb-1 text-xs font-semibold text-muted-foreground">{sections[index].day}</h3>
                )}
                itemContent={(index) => {
                  const row = rows[index];
                  const href = hrefFor(row.lead);
                  return (
                    <ActivityRowView
                      row={row}
                      href={href}
                      selected={row.key === activeKey}
                      actor={row.lead.actorID ? users.get(row.lead.actorID) : undefined}
                      emojiMap={emojiMap}
                      channel={channelByID.get(row.lead.parentID)}
                      conversation={conversationByID.get(row.lead.parentID)}
                      onOpen={onOpen}
                      onSetRead={onSetRead}
                      onRemove={onRemove}
                    />
                  );
                }}
              />
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
});
