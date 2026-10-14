import { computeReminderTime, toLocalInputValue } from '@/lib/reminder-times';
import type { ActivityRow } from '@/lib/activity-feed';

// What an Activity row's "Remind me about this" opens: the row to remind
// about and the dialog's seed time. The opener computes the seed in its
// event handler, so the clock is never read during render.
export interface ActivityReminder {
  row: ActivityRow;
  seed: string;
}

export function newActivityReminder(row: ActivityRow): ActivityReminder {
  return { row, seed: toLocalInputValue(computeReminderTime('in1h', new Date())) };
}
