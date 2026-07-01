// Reminder preset times. Pure date math so it's trivially unit-testable and
// stays consistent between the message action menu and any other caller.

import { inputValueForDate } from '@/lib/datetime-input';
import { localTimeZone } from '@/lib/user-time';

export type ReminderPresetKey = 'in20m' | 'in1h' | 'in3h' | 'tomorrow' | 'nextweek';

export interface ReminderPreset {
  key: ReminderPresetKey;
  label: string;
}

// REMINDER_PRESETS is the ordered menu shown under "Remind me". "Custom…" is a
// separate affordance (opens a modal) and is intentionally not in this list.
export const REMINDER_PRESETS: ReminderPreset[] = [
  { key: 'in20m', label: 'In 20 minutes' },
  { key: 'in1h', label: 'In 1 hour' },
  { key: 'in3h', label: 'In 3 hours' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'nextweek', label: 'Next week' },
];

// Hour-of-day for the "Tomorrow" / "Next week" presets — morning, like Slack.
const MORNING_HOUR = 9;

function atMorning(d: Date): Date {
  const r = new Date(d);
  r.setHours(MORNING_HOUR, 0, 0, 0);
  return r;
}

// toLocalInputValue formats a Date as the `YYYY-MM-DDTHH:mm` string a
// datetime-local input expects, in the user's local timezone. Thin wrapper over
// the shared datetime-input helper, fixed to the browser's own zone.
export function toLocalInputValue(d: Date): string {
  return inputValueForDate(d, localTimeZone());
}

// computeReminderTime returns the absolute fire time for a preset relative to
// `now`. Relative presets add a duration; "tomorrow" is the next calendar day at
// 9am local; "nextweek" is the next Monday at 9am local (always strictly in a
// future week, so picking it on a Monday lands on the following Monday).
export function computeReminderTime(key: ReminderPresetKey, now: Date): Date {
  switch (key) {
    case 'in20m':
      return new Date(now.getTime() + 20 * 60 * 1000);
    case 'in1h':
      return new Date(now.getTime() + 60 * 60 * 1000);
    case 'in3h':
      return new Date(now.getTime() + 3 * 60 * 60 * 1000);
    case 'tomorrow': {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      return atMorning(d);
    }
    case 'nextweek': {
      const d = new Date(now);
      // Days until the next Monday (getDay: 0=Sun..6=Sat). 0 → today is Monday
      // → jump a full week so "next week" is never today.
      const delta = ((1 - d.getDay() + 7) % 7) || 7;
      d.setDate(d.getDate() + delta);
      return atMorning(d);
    }
  }
}
