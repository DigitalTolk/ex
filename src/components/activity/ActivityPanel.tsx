import { memo, useCallback, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { GroupedVirtuoso } from 'react-virtuoso';
import { CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useMarkActivityRead, useReminders } from '@/hooks/useActivity';
import { useActivityRowData } from '@/hooks/useActivityRowData';
import { useCalendarDay } from '@/hooks/useCalendarDay';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ACTIVITY_TABS, activitySections, filterActivity, groupActivity, tabUnread, type ActivityRow, type ActivityTab } from '@/lib/activity-feed';
import { setActivityUnreadOnly, useSidebarModeStore } from '@/stores/sidebar-mode';
import { ActivityFilterTabs } from './ActivityFilterTabs';
import { ActivityRowView } from './ActivityRow';
import { ActivityReminderDialog } from './ActivityReminderDialog';
import { newActivityReminder, type ActivityReminder } from '@/lib/activity-reminder';
import { PendingReminders } from './PendingReminders';

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
  const {
    feed,
    isLoading,
    isError,
    refetch,
    items,
    allRows,
    hrefFor,
    slugFor,
    users,
    emojiMap,
    channelByID,
    conversationByID,
    setRead,
    openRow,
    onSetRead,
    onRemove,
    onClearBefore,
    onCopyLink,
    onMuteThread,
  } = useActivityRowData();
  // "Remind me about this" from a row's menu; the dialog outlives the menu.
  const [reminder, setReminder] = useState<ActivityReminder | null>(null);
  const onRemind = useCallback((row: ActivityRow) => setReminder(newActivityReminder(row)), []);
  const { data: reminders } = useReminders();
  const filter = useSidebarModeStore((s) => s.filter);
  const unreadOnly = useSidebarModeStore((s) => s.unreadOnly);
  const selectedKey = useSidebarModeStore((s) => s.selectedKey);
  const markAllRead = useMarkActivityRead();
  const location = useLocation();
  const isMobile = useIsMobile();

  const tabRows = useMemo(
    () => (filter === 'all' ? allRows : groupActivity(filterActivity(items, filter))),
    [allRows, items, filter],
  );
  // The opened row stays highlighted — and listed under "Unread only" — while
  // its message is the page on screen; going anywhere else lets it go.
  const selectedRow = tabRows.find((r) => r.key === selectedKey);
  const activeKey = selectedRow && pathOf(hrefFor(selectedRow.lead)) === location.pathname ? selectedRow.key : null;
  const rows = useMemo(
    () => (unreadOnly ? tabRows.filter((r) => r.unreadIDs.length > 0 || r.key === activeKey) : tabRows),
    [tabRows, unreadOnly, activeKey],
  );
  // Day headings and times follow the calendar day, so an open panel rolls
  // over at midnight.
  const today = useCalendarDay();
  const sections = useMemo(() => activitySections(rows, today), [rows, today]);
  const groupCounts = useMemo(() => sections.map((s) => s.rows.length), [sections]);
  // The virtual list keys its day headings and rows as one run.
  const listKeys = useMemo(() => sections.flatMap((s) => [`day:${s.day}`, ...s.rows.map((r) => r.key)]), [sections]);

  const unreadByTab = useMemo(() => {
    const out = {} as Record<ActivityTab, number>;
    for (const t of ACTIVITY_TABS) out[t.id] = feed ? tabUnread(feed, t.id) : 0;
    return out;
  }, [feed]);

  const onOpen = useCallback(
    (row: ActivityRow) => {
      openRow(row);
      onNavigate?.();
    },
    [openRow, onNavigate],
  );

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
                      today={today}
                      onRemind={onRemind}
                      onCopyLink={onCopyLink}
                      onMuteThread={onMuteThread}
                      onClearBefore={onClearBefore}
                    />
                  );
                }}
              />
            )}
          </div>
        </div>
      </ScrollArea>
      <ActivityReminderDialog reminder={reminder} channelSlug={reminder ? slugFor(reminder.row) : undefined} onClose={() => setReminder(null)} />
    </div>
  );
});
