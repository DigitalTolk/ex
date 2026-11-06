import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Calendar, CalendarDayButton } from '@/components/ui/calendar';
import { TimeWheel } from '@/components/ui/time-wheel';
import { useIsMobile } from '@/hooks/useIsMobile';
import { combineDateAndClock, describeDelay, formatClockTime, hourCycleOf, parseClockTime, splitDateTimeSeed, type ClockTime } from '@/lib/clock-time';
import { REMINDER_PRESETS, computeReminderTime } from '@/lib/reminder-times';
import { formatScheduleTime } from '@/lib/schedule-times';
import { inputValueForDate } from '@/lib/datetime-input';
import { dayKey } from '@/lib/format';
import { localTimeZone } from '@/lib/user-time';
import { ReminderPeoplePicker } from '@/components/chat/ReminderPeoplePicker';
import { NOBODY_ELSE, type ReminderAudience } from '@/lib/reminder-audience';

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
  // who it's for, and with a note, its text). It resolves on success (the
  // dialog then closes) and rejects on failure (the dialog stays open and
  // surfaces the error) — so scheduling is never silent.
  onConfirm: (when: Date, audience: ReminderAudience, note: string) => Promise<void>;
  // people adds the Who line: the picker, offering that chat's people.
  people?: ReminderPeople;
  // note adds the optional note field, starting from this text.
  note?: string;
  // copy rewords the dialog for another "pick a future time" use (scheduling
  // a message); reminders use the default.
  copy?: DateTimeDialogCopy;
  // The row of quick picks above the fields; reminders use their presets.
  quickPicks?: QuickPick[];
}

export interface ReminderPeople {
  parentID: string;
  parentType: 'channel' | 'conversation';
  // Who it's for to begin with: a reminder being edited, or "everyone"
  // from the Remind all menu.
  initial?: ReminderAudience;
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

// A reminder for everyone in the chat says so.
const REMIND_ALL_COPY: DateTimeDialogCopy = { ...REMINDER_COPY, title: 'Remind all', previewVerb: 'Reminds everyone' };

// A note's cap, as the server counts it (service.maxReminderNote).
const MAX_NOTE = 500;

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
// a calendar for the day, wheels for the time (spin, tap or type them, like a
// phone's alarm), a row of quick picks that fill both in one tap, a reminder's
// Who line (its list of people drops down over the dialog, so the dialog never
// grows), a note, and a preview line that reads the result back ("Sends Tomorrow at 9:00 AM ·
// in 21 h"). Validated to a strictly-future instant before the caller
// schedules it. Mount it fresh per open so the seed re-applies.
export function ReminderDialog({
  open,
  onOpenChange,
  initialValue,
  onConfirm,
  copy: copyProp,
  quickPicks = REMINDER_QUICK_PICKS,
  people,
  note: initialNote,
}: ReminderDialogProps) {
  const [fields, setFields] = useState(() => splitDateTimeSeed(initialValue));
  const [audience, setAudience] = useState<ReminderAudience>(() => people?.initial ?? NOBODY_ELSE);
  // The wording follows who it's for: a reminder's preview names everyone,
  // or how many others, whatever the title.
  const base = copyProp ?? (audience.everyone ? REMIND_ALL_COPY : REMINDER_COPY);
  const added = audience.userIDs.length;
  const previewVerb = !people
    ? base.previewVerb
    : audience.everyone
      ? REMIND_ALL_COPY.previewVerb
      : added
        ? `Reminds you and ${added === 1 ? '1 other' : `${added} others`}`
        : base.previewVerb;
  const copy = { ...base, previewVerb };
  const [note, setNote] = useState(initialNote ?? '');
  // The month the calendar shows; follows a quick pick, otherwise the reader's.
  const [month, setMonth] = useState<Date | undefined>(() => dateOf(splitDateTimeSeed(initialValue).date));
  // The preview compares against the clock, so it is worked out in the
  // handlers (never during render) and kept as text — a warning, with the
  // confirm held back, when the time picked has already gone. Its verb is
  // added as it renders, so it follows who the reminder is for.
  const [preview, setPreview] = useState<{ text: string; past: boolean } | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const isMobile = useIsMobile();

  const clock = parseClockTime(fields.time);
  const chosen = (next = fields): Date | null => {
    const time = parseClockTime(next.time);
    return time ? combineDateAndClock(next.date, time) : null;
  };
  const describe = (when: Date | null, now: Date) => {
    if (!when) return null;
    if (when.getTime() <= now.getTime()) return { text: `${formatScheduleTime(when, now)} has already passed`, past: true };
    return { text: `${formatScheduleTime(when, now)} · ${describeDelay(when.getTime() - now.getTime())}`, past: false };
  };
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
      await onConfirm(when, audience, note.trim());
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
            ? { label: pending ? copy.confirming : copy.confirm, onClick: () => void confirm(), disabled: pending || !!preview?.past }
            : undefined
        }
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 px-1 py-2">
          {people && (
            <ReminderPeoplePicker parentID={people.parentID} parentType={people.parentType} value={audience} onChange={setAudience} />
          )}
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
            <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 self-stretch">
              <TimeWheel value={clock} onChange={setTime} onEnter={() => void confirm()} hourCycle={HOUR_CYCLE} testIdPrefix="reminder" />
            </div>
          </div>
          {initialNote !== undefined && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Note (optional)</span>
              <textarea
                aria-label="Reminder note"
                data-testid="reminder-note"
                placeholder="What it's about, e.g. bring the Q3 numbers"
                maxLength={MAX_NOTE}
                rows={2}
                className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm mobile:text-base"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          )}
          {preview && (
            <p
              role={preview.past ? 'alert' : undefined}
              data-past={preview.past || undefined}
              className={`flex items-center gap-1.5 text-sm ${preview.past ? 'text-destructive' : 'text-muted-foreground'}`}
              data-testid="reminder-preview"
            >
              {preview.past && <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />}
              {preview.past ? preview.text : `${copy.previewVerb} ${preview.text}`}
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
            <Button onClick={confirm} disabled={pending || !!preview?.past} data-testid="reminder-confirm">
              {pending ? copy.confirming : copy.confirm}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
