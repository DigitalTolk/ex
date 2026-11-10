import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { ReminderDialog } from './ReminderDialog';
import { TimeWheel } from '@/components/ui/time-wheel';
import type { ClockTime } from '@/lib/clock-time';

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


const wheel = (part: string) => document.querySelector<HTMLElement>(`[data-testid="reminder-wheel-${part}"]`)!;
// offsetHeight: the row's layout height, untilted by the drum.
const rowHeight = () => wheel('minute').querySelector<HTMLElement>('[data-row]')!.offsetHeight;

// Spins a wheel by `rows` (down the list for positive), as a fling that ends
// there would, and waits for it to settle where that lands. One move: spread
// over frames, WebKit settled (and re-homed) between them and lost rows.
async function spin(part: string, rows: number) {
  const el = wheel(part);
  const value = el.getAttribute('aria-valuenow');
  el.scrollBy({ top: rows * rowHeight(), behavior: 'instant' });
  const n = Number(el.getAttribute('aria-valuemax')) + 1;
  const lands = String((((Number(value) + rows) % n) + n) % n);
  await vi.waitFor(() => expect(el.getAttribute('aria-valuenow')).toBe(lands));
}

describe('the reminder picker layout', () => {
  it('lays the wheels out with the chosen row in the band across the middle', async () => {
    await openAt('2026-10-21T09:00');
    const wheels = laidOut('[data-testid="reminder-wheel"]');
    const middle = wheels.top + wheels.height / 2;
    for (const id of ['hour-9', 'minute-0', 'am']) {
      const row = laidOut(`[data-testid="reminder-wheel-${id}"]`);
      expect(Math.abs(row.top + row.height / 2 - middle)).toBeLessThanOrEqual(1);
    }
    // Five rows show: two either side of the chosen one.
    expect(wheel('hour').offsetHeight).toBe(5 * rowHeight());
  });

  it.skipIf(window.innerWidth >= 640)('stacks a full-width calendar over the wheels on a phone', async () => {
    await openAt('2026-10-21T09:00');
    const calendar = laidOut('[data-slot="calendar"]');
    const wheels = laidOut('[data-testid="reminder-wheel"]');
    expect(wheels.top).toBeGreaterThan(calendar.bottom);
    expect(Math.abs((wheels.left + wheels.right) / 2 - (calendar.left + calendar.right) / 2)).toBeLessThanOrEqual(1);
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

// On a phone the keyboard covered half the sheet: whatever was typed low in
// it couldn't be seen. The time is picked on the wheels instead, and while
// a keyboard is up (a field further down, like the people
// to remind) the sheet ends where the keyboard begins, so the field scrolls
// into view above it.
describe.skipIf(window.__EX_FORCE_DEVICE__ === 'desktop')('the reminder picker on a phone', () => {
  it('picks the time by spinning the wheels, with no field to type into', async () => {
    const onConfirm = vi.fn((_when: Date, _people: string[]) => Promise.resolve());
    await render(<ReminderDialog open initialValue="2099-10-21T09:00" onConfirm={onConfirm} onOpenChange={vi.fn()} />);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="reminder-wheel"]')).not.toBeNull());
    expect(document.querySelector('input:not([type="hidden"])')).toBeNull();
    await spin('hour', -5); // 9 → 4
    await spin('minute', 22); // :00 → :22
    await userEvent.click(document.querySelector('[data-slot="dialog-mobile-action"]') as HTMLElement);
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const when = onConfirm.mock.calls[0][0];
    expect([when.getHours(), when.getMinutes()]).toEqual([4, 22]);
  });

  it('ends the sheet where the keyboard begins', async () => {
    document.documentElement.style.setProperty('--ex-app-height', '420px');
    try {
      await openAt('2099-10-21T09:00');
      const sheet = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!;
      // offsetHeight: the layout size, unscaled by the dialog's zoom-in.
      expect(sheet.offsetHeight).toBe(420);
    } finally {
      document.documentElement.style.removeProperty('--ex-app-height');
    }
  });
});

// A wheel is spun by scrolling it (a swipe, a trackpad, a mouse wheel); it
// settles on the row that stops in its box. The wheels go round.
function Controlled({ initial, hourCycle, onChange }: { initial: ClockTime; hourCycle?: 12 | 24; onChange: (t: ClockTime) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <TimeWheel
      value={value}
      hourCycle={hourCycle}
      testIdPrefix="reminder"
      onChange={(t) => {
        setValue(t);
        onChange(t);
      }}
    />
  );
}

describe('spinning the wheels', () => {
  it('settles on the row a spin stops at', async () => {
    const onChange = vi.fn();
    await render(<Controlled initial={{ hour: 9, minute: 0 }} onChange={onChange} />);
    await spin('minute', 41);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 41 });
    await spin('hour', -1);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 8, minute: 41 });
  });

  it('goes round past :59 to :00, and settles back in the middle of its rows', async () => {
    const onChange = vi.fn();
    await render(<Controlled initial={{ hour: 9, minute: 58 }} onChange={onChange} />);
    const minutes = wheel('minute');
    const before = minutes.scrollTop;
    await spin('minute', 3);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 9, minute: 1 });
    // As far from either end as before: it can keep going round.
    await vi.waitFor(() => expect(minutes.scrollTop).toBe(before - 57 * rowHeight()));
  });

  it('turns to a time set from outside, the short way', async () => {
    const { rerender } = await render(<TimeWheel value={{ hour: 9, minute: 58 }} onChange={vi.fn()} testIdPrefix="reminder" />);
    const minutes = wheel('minute');
    const before = minutes.scrollTop;
    const tops: number[] = [];
    minutes.addEventListener('scroll', () => tops.push(minutes.scrollTop));
    await rerender(<TimeWheel value={{ hour: 9, minute: 2 }} onChange={vi.fn()} testIdPrefix="reminder" />);
    // Four rows on, not 56 back — then, stopped, back to the middle copy.
    await vi.waitFor(() => expect(minutes.scrollTop).toBe(before - 56 * rowHeight()));
    // (A smooth scroll may overshoot a few pixels before it snaps.)
    expect(Math.round((Math.max(...tops) - before) / rowHeight())).toBe(4);
  });

  it('has 00–23 and no AM/PM on a 24-hour clock', async () => {
    const onChange = vi.fn();
    await render(<Controlled initial={{ hour: 9, minute: 0 }} hourCycle={24} onChange={onChange} />);
    expect(document.querySelector('[data-testid="reminder-wheel-period"]')).toBeNull();
    expect(wheel('hour').getAttribute('aria-valuetext')).toBe('09');
    await spin('hour', 6);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 15, minute: 0 });
  });
});
