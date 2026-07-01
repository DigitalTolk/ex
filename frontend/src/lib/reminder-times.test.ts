import { describe, it, expect } from 'vitest';
import {
  REMINDER_PRESETS,
  computeReminderTime,
  toLocalInputValue,
} from '@/lib/reminder-times';

describe('computeReminderTime', () => {
  // A Wednesday at 14:30 local.
  const now = new Date(2026, 5, 24, 14, 30, 0, 0);

  it('adds 20 minutes', () => {
    expect(computeReminderTime('in20m', now).getTime()).toBe(now.getTime() + 20 * 60 * 1000);
  });

  it('adds 1 hour', () => {
    expect(computeReminderTime('in1h', now).getTime()).toBe(now.getTime() + 60 * 60 * 1000);
  });

  it('adds 3 hours', () => {
    expect(computeReminderTime('in3h', now).getTime()).toBe(now.getTime() + 3 * 60 * 60 * 1000);
  });

  it('tomorrow is the next day at 9am local', () => {
    const r = computeReminderTime('tomorrow', now);
    expect(r.getDate()).toBe(25);
    expect(r.getHours()).toBe(9);
    expect(r.getMinutes()).toBe(0);
  });

  it('next week is the following Monday at 9am', () => {
    // 2026-06-24 is a Wednesday → next Monday is 2026-06-29.
    const r = computeReminderTime('nextweek', now);
    expect(r.getDay()).toBe(1); // Monday
    expect(r.getDate()).toBe(29);
    expect(r.getHours()).toBe(9);
  });

  it('next week from a Monday jumps a full week (never today)', () => {
    const monday = new Date(2026, 5, 29, 10, 0, 0, 0); // 2026-06-29 is a Monday
    const r = computeReminderTime('nextweek', monday);
    expect(r.getDay()).toBe(1);
    // 2026-06-29 + 7 days = 2026-07-06 (month rolls over).
    expect(r.getMonth()).toBe(6);
    expect(r.getDate()).toBe(6);
  });

  it('exposes a preset menu without a custom entry', () => {
    expect(REMINDER_PRESETS.map((p) => p.key)).toEqual(['in20m', 'in1h', 'in3h', 'tomorrow', 'nextweek']);
  });
});

describe('toLocalInputValue', () => {
  it('formats a datetime-local string with zero-padding', () => {
    expect(toLocalInputValue(new Date(2026, 0, 5, 8, 9))).toBe('2026-01-05T08:09');
  });
});
