// Times for scheduling a message: the quick picks in the composer's send menu
// and the friendly labels shown wherever a scheduled time appears. Pure date
// math (now is passed in) so it is trivially testable.

import { computeReminderTime } from '@/lib/reminder-times';

export interface SchedulePreset {
  key: 'tomorrow' | 'nextweek';
  label: string;
}

// 9:00 in the user's clock format, from a fixed date (no clock read).
const MORNING = new Date(2024, 0, 1, 9).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
// Jan 1 2024 was a Monday: its localized weekday name, again with no clock read.
const MONDAY = new Date(2024, 0, 1).toLocaleDateString(undefined, { weekday: 'long' });

// SCHEDULE_PRESETS are the composer's quick picks: tomorrow morning and next
// Monday morning (9:00, like reminders). The instant is worked out when one is
// picked: scheduleTimeFor(key, now).
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { key: 'tomorrow', label: `Tomorrow at ${MORNING}` },
  { key: 'nextweek', label: `${MONDAY} at ${MORNING}` },
];

export function scheduleTimeFor(key: SchedulePreset['key'], now: Date): Date {
  return computeReminderTime(key, now);
}

function dayDiff(a: Date, b: Date): number {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((start(a) - start(b)) / 86_400_000);
}

// formatScheduleTime says when a scheduled message goes out, relative to now:
// "Today at 3:30 PM", "Tomorrow at 9:00 AM", "Monday at 9:00 AM" within the
// week, then "Oct 20 at 9:00 AM" (with the year when it isn't this year).
export function formatScheduleTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = dayDiff(at, now);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  if (days > 1 && days < 7) return `${at.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
  const date = at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `${date} at ${time}`;
}
