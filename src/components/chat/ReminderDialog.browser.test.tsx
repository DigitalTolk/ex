import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { ReminderDialog } from './ReminderDialog';
import { ClockDial } from '@/components/ui/clock-dial';

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


// Presses the dial's face at the given angles (degrees clockwise from 12) on
// its outer ring — a press at the first, a drag through the rest — and lets go.
async function dragOnFace(angles: number[], ring = 0.4) {
  const face = document.querySelector<HTMLElement>('[data-testid="reminder-dial-face"]')!;
  const box = face.getBoundingClientRect();
  const at = (deg: number) => ({
    clientX: box.left + box.width / 2 + box.width * ring * Math.sin((deg * Math.PI) / 180),
    clientY: box.top + box.height / 2 - box.height * ring * Math.cos((deg * Math.PI) / 180),
  });
  const fire = (type: string, deg: number) =>
    face.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, ...at(deg) }));
  fire('pointerdown', angles[0]);
  for (const deg of angles.slice(1)) fire('pointermove', deg);
  fire('pointerup', angles[angles.length - 1]);
  await new Promise((r) => requestAnimationFrame(r));
}

describe('the reminder picker layout', () => {
  it('lays the clock dial out round, its twelve hours on the face', async () => {
    await openAt('2026-10-21T09:00');
    const face = laidOut('[data-testid="reminder-dial-face"]');
    expect(Math.round(face.width)).toBe(Math.round(face.height));
    for (const hour of [0, 3, 6, 9]) {
      const label = laidOut(`[data-testid="reminder-dial-hour-${hour}"]`);
      expect(label.left).toBeGreaterThanOrEqual(face.left);
      expect(label.right).toBeLessThanOrEqual(face.right);
    }
    // 12 at the top, 6 at the bottom.
    expect(laidOut('[data-testid="reminder-dial-hour-0"]').top).toBeLessThan(laidOut('[data-testid="reminder-dial-hour-6"]').top);
  });

  it.skipIf(window.innerWidth >= 640)('stacks a full-width calendar over the dial on a phone', async () => {
    await openAt('2026-10-21T09:00');
    const calendar = laidOut('[data-slot="calendar"]');
    const face = laidOut('[data-testid="reminder-dial-face"]');
    expect(face.top).toBeGreaterThan(calendar.bottom);
    expect(Math.abs((face.left + face.right) / 2 - (calendar.left + calendar.right) / 2)).toBeLessThanOrEqual(1);
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
// it couldn't be seen. The time is picked on the clock dial instead, and while
// a keyboard is up (a field further down, like the people
// to remind) the sheet ends where the keyboard begins, so the field scrolls
// into view above it.
describe.skipIf(window.__EX_FORCE_DEVICE__ === 'desktop')('the reminder picker on a phone', () => {
  it('picks the time on the dial, with no field to type into', async () => {
    const onConfirm = vi.fn((_when: Date, _people: string[]) => Promise.resolve());
    await render(<ReminderDialog open initialValue="2099-10-21T09:00" onConfirm={onConfirm} onOpenChange={vi.fn()} />);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="reminder-dial-face"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="reminder-time"]')).toBeNull();
    await dragOnFace([90, 120]); // to 4 o'clock
    await dragOnFace([132]); // the minutes, to :22
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

// Mouse and finger both pick by dragging the hand: the hour first, then —
// the dial having turned — the minutes, to the minute. A 24-hour clock reads
// a press on the inner ring as the afternoon hour.
describe('dragging the clock hand', () => {
  it('sets the hour, then the minutes, by where the hand is let go', async () => {
    const onConfirm = vi.fn((_when: Date, _people: string[]) => Promise.resolve());
    await render(<ReminderDialog open initialValue="2099-10-21T21:00" onConfirm={onConfirm} onOpenChange={vi.fn()} />);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="reminder-dial-face"]')).not.toBeNull());
    await dragOnFace([0, 60, 90]); // 3 o'clock, staying PM
    await vi.waitFor(() => expect(document.querySelector('[data-testid="reminder-dial-mode-minute"]')?.getAttribute('aria-pressed')).toBe('true'));
    await dragOnFace([200, 246]); // :41
    expect(document.querySelector('[data-testid="reminder-dial-mode-minute"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-testid="reminder-dial-mode-hour"]')?.textContent).toBe('3');
    expect(document.querySelector('[data-testid="reminder-dial-mode-minute"]')?.textContent).toBe('41');
    expect(document.querySelector('[data-testid="reminder-dial-pm"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('reads the inner ring as 13–00 on a 24-hour clock', async () => {
    const onChange = vi.fn();
    await render(<ClockDial value={{ hour: 9, minute: 0 }} onChange={onChange} hourCycle={24} testIdPrefix="reminder" />);
    // Each pick turns the dial to the minutes; back to the hours for the next.
    const hours = async () => {
      (document.querySelector('[data-testid="reminder-dial-mode-hour"]') as HTMLButtonElement).click();
      await vi.waitFor(() => expect(document.querySelector('[data-testid="reminder-dial-hour-0"]')).not.toBeNull());
    };
    await dragOnFace([90], 0.26);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 15, minute: 0 });
    await hours();
    await dragOnFace([0], 0.26);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 0, minute: 0 });
    await hours();
    await dragOnFace([0]);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 12, minute: 0 });
    await hours();
    await dragOnFace([90]);
    expect(onChange).toHaveBeenLastCalledWith({ hour: 3, minute: 0 });
  });
});
