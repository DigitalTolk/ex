import { describe, expect, it } from 'vitest';
import { clockTimeSuggestions, combineDateAndClock, describeDelay, formatClockTime, hourCycleOf, parseClockTime, splitDateTimeSeed, stepClockTime } from './clock-time';

describe('parseClockTime', () => {
  it('reads the shapes people type', () => {
    expect(parseClockTime('9')).toEqual({ hour: 9, minute: 0 });
    expect(parseClockTime('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseClockTime('9.15')).toEqual({ hour: 9, minute: 15 });
    expect(parseClockTime('930')).toEqual({ hour: 9, minute: 30 });
    expect(parseClockTime('1430')).toEqual({ hour: 14, minute: 30 });
    expect(parseClockTime(' 9am ')).toEqual({ hour: 9, minute: 0 });
    expect(parseClockTime('2:15 pm')).toEqual({ hour: 14, minute: 15 });
    expect(parseClockTime('12 AM')).toEqual({ hour: 0, minute: 0 });
    expect(parseClockTime('12 p.m.')).toEqual({ hour: 12, minute: 0 });
    expect(parseClockTime('0:05')).toEqual({ hour: 0, minute: 5 });
  });

  it('rejects what is not a time of day', () => {
    for (const bad of ['', 'soon', '25', '24:00', '9:60', '13pm', '0am', '9:3', '9:300']) {
      expect(parseClockTime(bad), bad).toBeNull();
    }
  });
});

describe('formatClockTime and suggestions', () => {
  it('formats in the runtime clock format and lists every half hour', () => {
    const nine = formatClockTime({ hour: 9, minute: 0 });
    expect(nine).toMatch(/9:00/);
    expect(formatClockTime({ hour: 13, minute: 5 }, 24)).toMatch(/13:05/);
    expect(formatClockTime({ hour: 13, minute: 5 }, 12)).toMatch(/1:05 PM/);
    const list = clockTimeSuggestions();
    expect(list).toHaveLength(48);
    expect(list).toContain(nine);
    expect(list[1]).toMatch(/12:30|0:30|00:30/);
  });
});

describe('combineDateAndClock and splitDateTimeSeed', () => {
  it('builds a local instant from the two fields and splits a seed back out', () => {
    const when = combineDateAndClock('2999-02-02', { hour: 10, minute: 30 })!;
    expect([when.getFullYear(), when.getMonth(), when.getDate(), when.getHours(), when.getMinutes()]).toEqual([2999, 1, 2, 10, 30]);
    expect(combineDateAndClock('', { hour: 1, minute: 0 })).toBeNull();
    expect(combineDateAndClock('2999-2-2', { hour: 1, minute: 0 })).toBeNull();
    expect(splitDateTimeSeed('2999-01-01T09:00')).toEqual({ date: '2999-01-01', time: formatClockTime({ hour: 9, minute: 0 }) });
    expect(splitDateTimeSeed('')).toEqual({ date: '', time: '' });
  });
});

describe('describeDelay', () => {
  it('rounds to a readable distance', () => {
    expect(describeDelay(10_000)).toBe('now');
    expect(describeDelay(20 * 60_000)).toBe('in 20 min');
    expect(describeDelay(3 * 3_600_000)).toBe('in 3 h');
    expect(describeDelay(75 * 60_000)).toBe('in 1 h 15 min');
    expect(describeDelay(26 * 3_600_000)).toBe('in 1 day');
    expect(describeDelay(5 * 86_400_000)).toBe('in 5 days');
  });
});

describe('hourCycleOf', () => {
  it('reads the clock style off a formatted sample', () => {
    expect(hourCycleOf('1:00 PM')).toBe(12);
    expect(hourCycleOf('13:00')).toBe(24);
  });
});

describe('stepClockTime', () => {
  it('moves by the step and wraps at midnight', () => {
    expect(stepClockTime({ hour: 9, minute: 50 }, 15)).toEqual({ hour: 10, minute: 5 });
    expect(stepClockTime({ hour: 0, minute: 10 }, -15)).toEqual({ hour: 23, minute: 55 });
    expect(stepClockTime({ hour: 23, minute: 50 }, 15)).toEqual({ hour: 0, minute: 5 });
  });
});
