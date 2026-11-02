import { expect } from 'vitest';
import { page, userEvent } from 'vitest/browser';

export function tomorrow(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d;
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// pickTomorrow picks tomorrow in the open reminder dialog's calendar the way a
// person does. The calendar opens on the seed's month, which shows tomorrow
// only when it is in that month or on the month's last row: a month that ends
// on the last day of the week (Saturday, October 31, with Sunday-first weeks)
// shows no days of the next one. Then it steps to the next month first.
export async function pickTomorrow() {
  const day = page.getByTestId(`reminder-day-${isoDay(tomorrow())}`);
  // Any day cell means the calendar has drawn its month.
  await expect.poll(() => document.querySelector('[data-testid^="reminder-day-"]')).not.toBeNull();
  if (day.query() === null) {
    await userEvent.click(page.getByRole('button', { name: 'Go to the Next Month' }));
  }
  await userEvent.click(day);
}
