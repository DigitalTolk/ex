import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { ReminderDialog } from './ReminderDialog';

// The date-and-time picker as laid out by a real browser: on a phone the
// calendar and the time list are stacked, and neither may run wider than the
// other or let the list grow to all 96 quarter hours.
function laidOut(selector: string): DOMRect {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el.getBoundingClientRect();
}

async function openAt(seed: string) {
  await render(<ReminderDialog open initialValue={seed} onConfirm={vi.fn(() => Promise.resolve())} onOpenChange={vi.fn()} />);
  await vi.waitFor(() => expect(document.querySelector('[data-slot="calendar"]')).not.toBeNull());
}

describe('the reminder picker layout', () => {
  it('opens the time list at the chosen time, the list scrolled and not grown to every slot', async () => {
    await openAt('2026-10-21T09:00');
    const list = laidOut('[role="listbox"][aria-label="Times"]');
    const chosen = laidOut('[data-testid="reminder-slot-9-0"]');
    expect(list.height).toBeLessThan(320);
    expect(chosen.top).toBeGreaterThanOrEqual(list.top);
    expect(chosen.bottom).toBeLessThanOrEqual(list.bottom);
  });

  it.skipIf(window.innerWidth >= 640)('stacks a calendar as wide as the time field on a phone', async () => {
    await openAt('2026-10-21T09:00');
    const calendar = laidOut('[data-slot="calendar"]');
    const time = laidOut('[data-testid="reminder-time"]');
    expect(Math.round(calendar.left)).toBe(Math.round(time.left));
    expect(Math.round(calendar.right)).toBe(Math.round(time.right));
    // Full width, the days keep a tap height rather than turning into
    // ever-taller squares.
    // offsetHeight: the layout size, unscaled by the dialog's zoom-in.
    expect(document.querySelector<HTMLElement>('[data-testid="reminder-day-2026-10-21"]')!.offsetHeight).toBe(44);
  });

  // Full screen on a phone, the dialog's rows used to stretch to fill it,
  // leaving a band of empty space between the title and the picker.
  it.skipIf(window.__EX_FORCE_DEVICE__ === 'desktop')('keeps the picker right under the title on a phone', async () => {
    await openAt('2026-10-21T09:00');
    const title = laidOut('[data-slot="dialog-title"]');
    const picks = laidOut('[role="group"][aria-label="Quick picks"]');
    expect(picks.top - title.bottom).toBeLessThanOrEqual(24);
  });
});
