import { describe, expect, it } from 'vitest';
import { SCHEDULE_PRESETS, formatScheduleTime, scheduleTimeFor } from './schedule-times';

const at = (y: number, mo: number, d: number, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi);
const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

describe('schedule times', () => {
  it('offers tomorrow morning and next Monday morning', () => {
    expect(SCHEDULE_PRESETS.map((p) => p.key)).toEqual(['tomorrow', 'nextweek']);
    expect(SCHEDULE_PRESETS[0].label).toBe(`Tomorrow at ${clock(at(2024, 1, 1))}`);
    expect(SCHEDULE_PRESETS[1].label).toMatch(/at /);
    const wed = at(2026, 10, 7, 15);
    expect(scheduleTimeFor('tomorrow', wed)).toEqual(at(2026, 10, 8));
    expect(scheduleTimeFor('nextweek', wed)).toEqual(at(2026, 10, 12));
  });

  it('says when it goes out, relative to now', () => {
    const now = at(2026, 10, 7, 15); // a Wednesday
    expect(formatScheduleTime(at(2026, 10, 7, 17, 30), now)).toBe(`Today at ${clock(at(2026, 10, 7, 17, 30))}`);
    expect(formatScheduleTime(at(2026, 10, 8), now)).toBe(`Tomorrow at ${clock(at(2026, 10, 8))}`);
    expect(formatScheduleTime(at(2026, 10, 12), now)).toBe(
      `${at(2026, 10, 12).toLocaleDateString(undefined, { weekday: 'long' })} at ${clock(at(2026, 10, 12))}`,
    );
    const later = at(2026, 10, 20);
    expect(formatScheduleTime(later, now)).toBe(
      `${later.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${clock(later)}`,
    );
    const nextYear = at(2027, 1, 5);
    expect(formatScheduleTime(nextYear, now)).toContain('2027');
    // An overdue (failed) one in the past reads as a date, too.
    expect(formatScheduleTime(at(2026, 10, 1), now)).toContain(at(2026, 10, 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  });
});
