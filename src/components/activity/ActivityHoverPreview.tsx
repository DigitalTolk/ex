import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { PopoverPortal } from '@/components/PopoverPortal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useActivityRowData } from '@/hooks/useActivityRowData';
import { useCalendarDay } from '@/hooks/useCalendarDay';
import { currentLayoutTier } from '@/lib/device';
import type { ActivityRow } from '@/lib/activity-feed';
import { setActivityUnreadOnly, setSidebarMode, useSidebarModeStore } from '@/stores/sidebar-mode';
import { ActivityRowView } from './ActivityRow';
import { ActivityReminderDialog } from './ActivityReminderDialog';
import { newActivityReminder, type ActivityReminder } from '@/lib/activity-reminder';

// Resting the mouse on the Activity bell opens a quick, linear look at the
// latest activity, Slack-style, without switching the sidebar. Desktop only:
// a phone has no hover, and its Activity tab is a tap away anyway. While the
// sidebar already shows Activity there is nothing to preview.
export const PREVIEW_OPEN_DELAY_MS = 350;
export const PREVIEW_CLOSE_DELAY_MS = 200;
export const PREVIEW_ROWS = 8;

export interface HoverPreviewTrigger {
  ref: RefObject<HTMLButtonElement | null>;
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onClick: () => void;
}

interface ActivityHoverPreviewProps {
  children: (trigger: HoverPreviewTrigger) => ReactNode;
}

export function ActivityHoverPreview({ children }: ActivityHoverPreviewProps) {
  const mode = useSidebarModeStore((s) => s.mode);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const cancelTimers = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);
  useEffect(() => cancelTimers, [cancelTimers]);

  const onPointerEnter = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // A finger "enters" on tap; only a resting mouse or pen previews.
      if (event.pointerType === 'touch' || currentLayoutTier() === 'mobile') return;
      clearTimeout(closeTimer.current);
      clearTimeout(openTimer.current);
      openTimer.current = setTimeout(() => setOpen(true), PREVIEW_OPEN_DELAY_MS);
    },
    [],
  );
  // Leaving the bell or the card starts the close; crossing between the two
  // within the grace period keeps it open.
  const onPointerLeave = useCallback(() => {
    clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), PREVIEW_CLOSE_DELAY_MS);
  }, []);
  const onCardEnter = useCallback(() => clearTimeout(closeTimer.current), []);
  const close = useCallback(() => {
    cancelTimers();
    setOpen(false);
  }, [cancelTimers]);

  // "Remind me about this" from a row in the card: the card closes and the
  // dialog, held here, outlives it.
  const [reminder, setReminder] = useState<ActivityReminder | null>(null);
  const [reminderSlug, setReminderSlug] = useState<string | undefined>(undefined);
  const onRemind = (row: ActivityRow, channelSlug: string | undefined) => {
    setReminder(newActivityReminder(row));
    setReminderSlug(channelSlug);
    close();
  };

  const shown = open && mode !== 'activity';
  return (
    <>
      {children({ ref: triggerRef, onPointerEnter, onPointerLeave, onClick: close })}
      <ActivityReminderDialog reminder={reminder} channelSlug={reminderSlug} onClose={() => setReminder(null)} />
      <PopoverPortal
        open={shown}
        triggerRef={triggerRef}
        onDismiss={close}
        estimatedWidth={368}
        estimatedHeight={440}
        preferredSide="bottom"
        preferredAlign="start"
        role="dialog"
        ariaLabel="Recent activity"
        className="w-[368px] overflow-hidden rounded-lg border bg-popover shadow-lg"
      >
        {shown ? <ActivityPreviewContent onPointerEnter={onCardEnter} onPointerLeave={onPointerLeave} onClose={close} onRemind={onRemind} /> : null}
      </PopoverPortal>
    </>
  );
}

interface ActivityPreviewContentProps {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: () => void;
  onRemind: (row: ActivityRow, channelSlug: string | undefined) => void;
}

// The card: a header with an Unreads toggle, the newest rows in one list
// (no day headings, no tabs), and a way into the full Activity sidebar.
// Mounted only while open, so its queries run only then.
function ActivityPreviewContent({ onPointerEnter, onPointerLeave, onClose, onRemind }: ActivityPreviewContentProps) {
  const { feed, isLoading, allRows, hrefFor, slugFor, users, emojiMap, channelByID, conversationByID, openRow, onSetRead, onRemove, onClearBefore, onCopyLink, onMuteThread } =
    useActivityRowData();
  const remind = useCallback((row: ActivityRow) => onRemind(row, slugFor(row)), [onRemind, slugFor]);
  // The same Unreads setting as the Activity sidebar's (stores/sidebar-mode):
  // turning it on here filters there too, and the other way round.
  const unreadOnly = useSidebarModeStore((st) => st.unreadOnly);
  const today = useCalendarDay();
  // A row's "..." menu is portaled outside the card, so the pointer "leaves"
  // the card on its way to a menu item. While a menu is open the card stays;
  // when it closes, the card goes unless the pointer is back on it.
  const cardRef = useRef<HTMLDivElement>(null);
  const menuOpenRef = useRef(false);
  const leaveCard = useCallback(() => {
    if (!menuOpenRef.current) onPointerLeave();
  }, [onPointerLeave]);
  const onMenuOpenChange = useCallback(
    (open: boolean) => {
      menuOpenRef.current = open;
      if (!open && !cardRef.current?.matches(':hover')) onPointerLeave();
    },
    [onPointerLeave],
  );
  const rows = (unreadOnly ? allRows.filter((r) => r.unreadIDs.length > 0) : allRows).slice(0, PREVIEW_ROWS);
  const onOpen = useCallback(
    (row: ActivityRow) => {
      openRow(row);
      onClose();
    },
    [openRow, onClose],
  );
  const openActivity = () => {
    setSidebarMode('activity');
    onClose();
  };

  return (
    <div ref={cardRef} className="flex flex-col text-sidebar-foreground" onPointerEnter={onPointerEnter} onPointerLeave={leaveCard} data-testid="activity-preview">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">Activity</h2>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          Unreads
          <Switch size="sm" checked={unreadOnly} onCheckedChange={setActivityUnreadOnly} data-testid="activity-preview-unreads" />
        </label>
      </div>
      <div className="max-h-96 overflow-y-auto px-1 py-1">
        {isLoading && (
          <div className="space-y-2 p-2" data-testid="activity-preview-loading">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        )}
        {feed && rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="activity-preview-empty">
            {unreadOnly ? 'No unread activity' : 'No activity yet'}
          </p>
        )}
        {rows.map((row) => (
          <ActivityRowView
            key={row.key}
            row={row}
            href={hrefFor(row.lead)}
            selected={false}
            actor={row.lead.actorID ? users.get(row.lead.actorID) : undefined}
            emojiMap={emojiMap}
            channel={channelByID.get(row.lead.parentID)}
            conversation={conversationByID.get(row.lead.parentID)}
            onOpen={onOpen}
            onSetRead={onSetRead}
            onRemove={onRemove}
            today={today}
            onMenuOpenChange={onMenuOpenChange}
            onRemind={remind}
            onCopyLink={onCopyLink}
            onMuteThread={onMuteThread}
            onClearBefore={onClearBefore}
          />
        ))}
      </div>
      <div className="border-t p-2">
        <Button variant="ghost" size="sm" className="w-full" onClick={openActivity} data-testid="activity-preview-open">
          Open Activity
        </Button>
      </div>
    </div>
  );
}
