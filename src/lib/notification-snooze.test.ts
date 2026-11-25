import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeSnoozeEnd, INDEFINITE_SNOOZE_MINUTES, minutesUntilTomorrow, snoozeEnd } from './notification-snooze';

const MINUTE = 60_000;
// The clock time as the user's locale writes it, the way the module does.
const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

afterEach(() => {
  vi.useRealTimers();
});

describe('snoozeEnd', () => {
  const now = new Date(2026, 0, 15, 10, 0).getTime();

  it('is null while Do Not Disturb was never set', () => {
    expect(snoozeEnd(undefined, now)).toBeNull();
    expect(snoozeEnd(null, now)).toBeNull();
    expect(snoozeEnd({}, now)).toBeNull();
  });

  it('is the end time while the snooze is still running', () => {
    const until = new Date(now + 30 * MINUTE).toISOString();
    expect(snoozeEnd({ snoozeUntil: until }, now)?.toISOString()).toBe(until);
  });

  it('is null once the snooze is over, and at the very moment it ends', () => {
    expect(snoozeEnd({ snoozeUntil: new Date(now - MINUTE).toISOString() }, now)).toBeNull();
    expect(snoozeEnd({ snoozeUntil: new Date(now).toISOString() }, now)).toBeNull();
  });

  it('measures against the current time when none is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const until = new Date(now + MINUTE).toISOString();
    expect(snoozeEnd({ snoozeUntil: until })?.toISOString()).toBe(until);
    vi.setSystemTime(now + 2 * MINUTE);
    expect(snoozeEnd({ snoozeUntil: until })).toBeNull();
  });
});

describe('minutesUntilTomorrow', () => {
  it('reaches 9 the next morning, local time', () => {
    expect(minutesUntilTomorrow(new Date(2026, 0, 15, 22, 30))).toBe(10 * 60 + 30);
    expect(minutesUntilTomorrow(new Date(2026, 0, 15, 9, 0))).toBe(24 * 60);
  });

  it('rounds a part of a minute up, so alerts never come back early', () => {
    expect(minutesUntilTomorrow(new Date(2026, 0, 15, 8, 59, 30))).toBe(24 * 60 + 1);
  });

  it('counts from the current time when none is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 21, 0));
    expect(minutesUntilTomorrow()).toBe(12 * 60);
  });
});

describe('describeSnoozeEnd', () => {
  const now = new Date(2026, 0, 15, 10, 0);

  it('gives the time for a snooze that ends today', () => {
    const end = new Date(2026, 0, 15, 15, 30);
    expect(describeSnoozeEnd(end, now)).toBe(`until ${clock(end)}`);
  });

  it('says tomorrow for one that ends the next day', () => {
    const end = new Date(2026, 0, 16, 9, 0);
    expect(describeSnoozeEnd(end, now)).toBe(`until tomorrow, ${clock(end)}`);
  });

  it('gives the date beyond that', () => {
    const end = new Date(2026, 0, 20, 9, 0);
    const date = end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(describeSnoozeEnd(end, now)).toBe(`until ${date}, ${clock(end)}`);
    expect(describeSnoozeEnd(end, now)).toContain('20');
  });

  it('says "until you turn them back on" for the indefinite snooze', () => {
    const end = new Date(now.getTime() + INDEFINITE_SNOOZE_MINUTES * MINUTE);
    expect(describeSnoozeEnd(end, now)).toBe('until you turn them back on');
  });

  it('measures against the current time when none is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const end = new Date(2026, 0, 15, 11, 0);
    expect(describeSnoozeEnd(end)).toBe(`until ${clock(end)}`);
  });
});
