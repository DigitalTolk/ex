import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { ClockDial } from '@/components/ui/clock-dial';
import { useIsMobile } from '@/hooks/useIsMobile';
import { combineDateAndClock, describeDelay, formatClockTime, hourCycleOf, parseClockTime, splitDateTimeSeed, type ClockTime } from '@/lib/clock-time';
import { REMINDER_PRESETS, computeReminderTime } from '@/lib/reminder-times';
import { formatScheduleTime } from '@/lib/schedule-times';
import { inputValueForDate } from '@/lib/datetime-input';
import { dayKey } from '@/lib/format';
import { localTimeZone } from '@/lib/user-time';
import { ReminderPeoplePicker } from '@/components/chat/ReminderPeoplePicker';

// A quick pick fills the calendar and time with a ready-made instant; the
// reader can still adjust before confirming.
export interface QuickPick {
  key: string;
  label: string;
  at: (now: Date) => Date;
}

interface ReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // initialValue is a `YYYY-MM-DDTHH:mm` seed (computed by the opener so the
  // impure clock read happens in an event handler, never during render).
  initialValue: string;
  // onConfirm schedules the reminder for the chosen time (and, with people,
  // the people picked). It resolves on success (the dialog then closes) and
  // rejects on failure (the dialog stays open and surfaces the error) — so
  // scheduling is never silent.
  onConfirm: (when: Date, userIDs: string[]) => Promise<void>;
  // people adds the "Also remind" picker, offering that chat's people.
  people?: ReminderPeople;
  // copy rewords the dialog for another "pick a future time" use (scheduling
  // a message); reminders use the default.
  copy?: DateTimeDialogCopy;
  // The row of quick picks above the fields; reminders use their presets.
  quickPicks?: QuickPick[];
}

export interface ReminderPeople {
  parentID: string;
  parentType: 'channel' | 'conversation';
  // Who is already on it, when editing a reminder.
  initial?: string[];
}

export interface DateTimeDialogCopy {
  title: string;
  inputLabel: string;
  confirm: string;
  confirming: string;
  failed: string;
  // "Sends" / "Reminds you": how the preview line starts.
  previewVerb: string;
}

const REMINDER_COPY: DateTimeDialogCopy = {
  title: 'Remind me',
  inputLabel: 'Reminder time',
  confirm: 'Set reminder',
  confirming: 'Setting…',
  failed: "Couldn't set the reminder — please try again.",
  previewVerb: 'Reminds you',
};

const REMINDER_QUICK_PICKS: QuickPick[] = REMINDER_PRESETS.map((preset) => ({
  key: preset.key,
  label: preset.label,
  at: (now) => computeReminderTime(preset.key, now),
}));

// The reader's clock style, from a fixed date so no clock is read.
const HOUR_CYCLE = hourCycleOf(new Date(2024, 0, 1, 13).toLocaleTimeString(undefined, { hour: 'numeric' }));

// The calendar's day for a `YYYY-MM-DD` field (local midnight), if any.
const dateOf = (date: string): Date | undefined => combineDateAndClock(date, { hour: 0, minute: 0 }) ?? undefined;

// ReminderDialog is the "Custom…" picker for reminders and scheduled sends:
// a calendar for the day, a clock dial for the time (tap or drag it, or type
// into the time above it), a row of quick picks that fill both in one tap,
// and a preview line that reads the result back ("Sends Tomorrow at 9:00 AM ·
// in 21 h"). Validated to a strictly-future instant before the caller
// schedules it. Mount it fresh per open so the seed re-applies.
export function ReminderDialog({
  open,
  onOpenChange,
  initialValue,
  onConfirm,
  copy = REMINDER_COPY,
  quickPicks = REMINDER_QUICK_PICKS,
  people,
}: ReminderDialogProps) {
  const [fields, setFields] = useState(() => splitDateTimeSeed(initialValue));
  const [userIDs, setUserIDs] = useState<string[]>(() => people?.initial ?? []);
  // The month the calendar shows; follows a quick pick, otherwise the reader's.
  const [month, setMonth] = useState<Date | undefined>(() => dateOf(splitDateTimeSeed(initialValue).date));
  // The preview compares against the clock, so it is worked out in the
  // handlers (never during render) and kept as text.
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const isMobile = useIsMobile();

  const clock = parseClockTime(fields.time);
  const chosen = (next = fields): Date | null => {
    const time = parseClockTime(next.time);
    return time ? combineDateAndClock(next.date, time) : null;
  };
  const describe = (when: Date | null, now: Date) =>
    when && when.getTime() > now.getTime() ? `${copy.previewVerb} ${formatScheduleTime(when, now)} · ${describeDelay(when.getTime() - now.getTime())}` : '';
  const update = (next: { date: string; time: string }) => {
    setFields(next);
    setError('');
    setPreview(describe(chosen(next), new Date()));
  };
  const setTime = (time: ClockTime) => update({ ...fields, time: formatClockTime(time) });
  const pick = (quick: QuickPick) => {
    const now = new Date();
    const at = quick.at(now);
    const seed = splitDateTimeSeed(inputValueForDate(at, localTimeZone()));
    setFields(seed);
    setMonth(at);
    setError('');
    setPreview(describe(at, now));
  };

  const confirm = async () => {
    const when = chosen();
    if (!when) {
      setError(clock ? 'Pick a date.' : 'Pick a time.');
      return;
    }
    if (when.getTime() <= Date.now()) {
      setError('Pick a time in the future.');
      return;
    }
    setPending(true);
    setError('');
    try {
      await onConfirm(when, userIDs);
      onOpenChange(false);
    } catch {
      setError(copy.failed);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mobile: the confirm moves to the top-right header so it is never
          under the keyboard or off the bottom of the screen. */}
      <DialogContent
        size="lg"
        data-testid="reminder-dialog"
        mobileCloseLabel="Cancel"
        mobileAction={
          isMobile
            ? { label: pending ? copy.confirming : copy.confirm, onClick: () => void confirm(), disabled: pending }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 px-1 py-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick picks">
            {quickPicks.map((quick) => (
              <button
                key={quick.key}
                type="button"
                onClick={() => pick(quick)}
                data-testid={`reminder-quick-${quick.key}`}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted mobile:py-1.5 mobile:text-sm"
              >
                {quick.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <Calendar
              mode="single"
              // A tap on the chosen day keeps it chosen. Unrequired, it cleared
              // the date: late in the evening the seed is already tomorrow,
              // and tapping tomorrow left "Pick a date." on Set.
              required
              selected={dateOf(fields.date)}
              onSelect={(day) => update({ ...fields, date: dayKey(day) })}
              month={month}
              onMonthChange={setMonth}
              // A phone stacks it over the time field, as wide as the field.
              className="rounded-md border border-border max-sm:w-full"
              components={{
                DayButton: (props) => <CalendarDayButton {...props} data-testid={`reminder-day-${dayKey(props.day.date)}`} />,
              }}
            />
            <div className="flex min-w-0 flex-1 flex-col items-center gap-3">
              <ClockDial value={clock} onChange={setTime} onEnter={() => void confirm()} hourCycle={HOUR_CYCLE} testIdPrefix="reminder" />
            </div>
          </div>
          {people && (
            <ReminderPeoplePicker parentID={people.parentID} parentType={people.parentType} value={userIDs} onChange={setUserIDs} />
          )}
          {preview && (
            <p className="text-sm text-muted-foreground" data-testid="reminder-preview">
              {preview}
            </p>
          )}
          {error && (
            <p className="text-xs text-destructive" data-testid="reminder-error">
              {error}
            </p>
          )}
        </div>
        {!isMobile && (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} data-testid="reminder-cancel">
              Cancel
            </Button>
            <Button onClick={confirm} disabled={pending} data-testid="reminder-confirm">
              {pending ? copy.confirming : copy.confirm}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
