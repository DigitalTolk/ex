import { useRef, useState, type ReactNode } from 'react';
import { CalendarClock, ChevronDown, Clock } from 'lucide-react';
import { triggerMessageActionHaptic } from '@/lib/haptics';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ReminderDialog, type DateTimeDialogCopy, type QuickPick } from '@/components/chat/ReminderDialog';
import { SCHEDULE_PRESETS, scheduleTimeFor } from '@/lib/schedule-times';
import { computeReminderTime, toLocalInputValue } from '@/lib/reminder-times';

const SCHEDULE_COPY: DateTimeDialogCopy = {
  title: 'Schedule message',
  description: 'Choose when to send this message.',
  inputLabel: 'Send time',
  confirm: 'Schedule',
  confirming: 'Scheduling…',
  failed: "Couldn't schedule the message — please try again.",
  previewVerb: 'Sends',
};

// The picker's quick picks: the menu's two mornings plus the short hops.
const SCHEDULE_QUICK_PICKS: QuickPick[] = [
  { key: 'in1h', label: 'In 1 hour', at: (now) => computeReminderTime('in1h', now) },
  { key: 'in3h', label: 'In 3 hours', at: (now) => computeReminderTime('in3h', now) },
  ...SCHEDULE_PRESETS.map((preset) => ({ key: preset.key, label: preset.label, at: (now: Date) => scheduleTimeFor(preset.key, now) })),
];

interface ScheduleSendMenuProps {
  disabled: boolean;
  // Schedules the composed message; rejects (and the composer keeps its
  // text) when scheduling fails.
  onSchedule: (sendAt: Date) => Promise<void>;
  // Tells the composer a menu is open, so a phone's toolbar stays put while
  // focus leaves the editor (like its emoji/GIF pickers).
  onOpenChange?: (open: boolean) => void;
  className?: string;
  // Phone: the Send button itself is the trigger — a tap sends (onSend), a
  // press-and-hold opens the schedule options. Without it, the trigger is
  // the small ⌄ beside Send.
  hold?: { onSend: () => void; label: string; children: ReactNode };
}

// How long a press on Send must last before it opens the schedule options.
const HOLD_MS = 450;

// ScheduleSendMenu is the small ⌄ beside Send (or, on a phone, a press and
// hold on Send itself): send this message later instead — tomorrow morning,
// next Monday morning, or at a custom time.
export function ScheduleSendMenu({ disabled, onSchedule, onOpenChange, className, hold }: ScheduleSendMenuProps) {
  // The custom-time dialog's seed, set when it's opened: tomorrow morning,
  // the most common pick, so the fields start somewhere useful.
  const [customSeed, setCustomSeed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  // Hold-to-open (phone): only the hold opens the menu, never a tap — the
  // trigger's own press-to-open is refused, and the tap that ends a hold
  // doesn't also send.
  const holdTimer = useRef<number | undefined>(undefined);
  const held = useRef(false);
  const cancelHold = () => window.clearTimeout(holdTimer.current);
  const startHold = () => {
    held.current = false;
    cancelHold();
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      triggerMessageActionHaptic();
      changeOpen(true);
    }, HOLD_MS);
  };
  const tapSend = () => {
    if (held.current) {
      held.current = false;
      return;
    }
    hold?.onSend();
  };
  return (
    <>
      <DropdownMenu
        modal={false}
        open={open}
        // In hold mode the menu opens only from the hold timer.
        onOpenChange={(next) => (hold && next ? undefined : changeOpen(next))}
      >
        {hold ? (
          <DropdownMenuTrigger
            onPointerDown={startHold}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
            // No text-selection callout or context menu under a held finger.
            onContextMenu={(e) => e.preventDefault()}
            onClick={tapSend}
            disabled={disabled}
            aria-label={hold.label}
            aria-description="Press and hold to schedule"
            data-testid="schedule-send-hold"
            className={`select-none [-webkit-touch-callout:none] ${className ?? ''}`}
          >
            {hold.children}
          </DropdownMenuTrigger>
        ) : (
          <DropdownMenuTrigger
            // Opened on click: the composer toolbar cancels pointerdown to keep
            // the editor focused, which also swallows the press the menu would
            // otherwise open on.
            onClick={() => changeOpen(true)}
            disabled={disabled}
            aria-label="Schedule message"
            title="Schedule for later"
            data-testid="schedule-send-trigger"
            className={className}
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </DropdownMenuTrigger>
        )}
        <DropdownMenuContent align="end" side={hold ? 'top' : 'bottom'} className="w-56">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Schedule message</div>
          {SCHEDULE_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.key}
              onClick={() => void onSchedule(scheduleTimeFor(preset.key, new Date())).catch(() => undefined)}
              aria-label={`Send ${preset.label}`}
            >
              <CalendarClock className="mr-2 h-4 w-4" />
              {preset.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => setCustomSeed(toLocalInputValue(scheduleTimeFor('tomorrow', new Date())))}
            aria-label="Pick a custom time"
          >
            <Clock className="mr-2 h-4 w-4" />
            Custom time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {customSeed !== null && (
        <ReminderDialog
          open
          // No trigger: the dialog only ever asks to close.
          onOpenChange={() => setCustomSeed(null)}
          initialValue={customSeed}
          onConfirm={onSchedule}
          copy={SCHEDULE_COPY}
          quickPicks={SCHEDULE_QUICK_PICKS}
        />
      )}
    </>
  );
}
