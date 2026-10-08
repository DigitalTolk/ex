import { useState } from 'react';
import { CalendarClock, ChevronDown, Clock } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ReminderDialog, type DateTimeDialogCopy } from '@/components/chat/ReminderDialog';
import { SCHEDULE_PRESETS, scheduleTimeFor } from '@/lib/schedule-times';
import { toLocalInputValue } from '@/lib/reminder-times';

const SCHEDULE_COPY: DateTimeDialogCopy = {
  title: 'Schedule message',
  description: 'Choose when to send this message.',
  inputLabel: 'Send time',
  confirm: 'Schedule',
  confirming: 'Scheduling…',
  failed: "Couldn't schedule the message — please try again.",
};

interface ScheduleSendMenuProps {
  disabled: boolean;
  // Schedules the composed message; rejects (and the composer keeps its
  // text) when scheduling fails.
  onSchedule: (sendAt: Date) => Promise<void>;
  // Tells the composer a menu is open, so a phone's toolbar stays put while
  // focus leaves the editor (like its emoji/GIF pickers).
  onOpenChange?: (open: boolean) => void;
  className?: string;
}

// ScheduleSendMenu is the small ⌄ beside Send: send this message later
// instead — tomorrow morning, next Monday morning, or at a custom time.
export function ScheduleSendMenu({ disabled, onSchedule, onOpenChange, className }: ScheduleSendMenuProps) {
  // The custom-time dialog's seed, set when it's opened (one hour from now).
  const [customSeed, setCustomSeed] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <DropdownMenu modal={false} open={open} onOpenChange={changeOpen}>
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
        <DropdownMenuContent align="end" className="w-56">
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
            onClick={() => setCustomSeed(toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)))}
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
        />
      )}
    </>
  );
}
