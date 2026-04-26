import { describe, it, expect } from 'vitest';
import { ordinalSuffix, formatLongDateTime, formatDayHeading, dayKey } from '@/lib/format';

describe('ordinalSuffix', () => {
  it('handles 1, 2, 3, 4 correctly', () => {
    expect(ordinalSuffix(1)).toBe('st');
    expect(ordinalSuffix(2)).toBe('nd');
    expect(ordinalSuffix(3)).toBe('rd');
    expect(ordinalSuffix(4)).toBe('th');
  });

  it('handles the 11/12/13 exception block', () => {
    expect(ordinalSuffix(11)).toBe('th');
    expect(ordinalSuffix(12)).toBe('th');
    expect(ordinalSuffix(13)).toBe('th');
  });

  it('handles 21st, 22nd, 23rd at month-end', () => {
    expect(ordinalSuffix(21)).toBe('st');
    expect(ordinalSuffix(22)).toBe('nd');
    expect(ordinalSuffix(23)).toBe('rd');
    expect(ordinalSuffix(31)).toBe('st');
  });
});

describe('formatLongDateTime', () => {
  it('renders "Mar 26th at 18:33:01" for the example date', () => {
    const d = new Date(2026, 2, 26, 18, 33, 1);
    expect(formatLongDateTime(d)).toBe('Mar 26th at 18:33:01');
  });

  it('zero-pads single-digit hours/minutes/seconds', () => {
    const d = new Date(2026, 0, 1, 9, 5, 7);
    expect(formatLongDateTime(d)).toBe('Jan 1st at 09:05:07');
  });

  it('accepts ISO strings as well as Date instances', () => {
    const d = new Date(2026, 4, 22, 14, 0, 0);
    expect(formatLongDateTime(d.toISOString())).toBe(formatLongDateTime(d));
  });
});

describe('formatDayHeading', () => {
  it('returns "Today" when the timestamp is in the same calendar day', () => {
    const now = new Date(2026, 3, 26, 14, 0, 0);
    const sameDay = new Date(2026, 3, 26, 8, 30, 0);
    expect(formatDayHeading(sameDay, now)).toBe('Today');
  });

  it('returns "Yesterday" for the day before', () => {
    const now = new Date(2026, 3, 26, 14, 0, 0);
    const y = new Date(2026, 3, 25, 23, 59, 0);
    expect(formatDayHeading(y, now)).toBe('Yesterday');
  });

  it('returns month + day without year when in the same year', () => {
    const now = new Date(2026, 3, 26);
    expect(formatDayHeading(new Date(2026, 2, 11), now)).toBe('Mar 11th');
  });

  it('includes the year for older dates', () => {
    const now = new Date(2026, 3, 26);
    expect(formatDayHeading(new Date(2025, 11, 31), now)).toBe('Dec 31st, 2025');
  });
});

describe('dayKey', () => {
  it('formats as YYYY-MM-DD with zero padding', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dayKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('groups two timestamps on the same day to the same key', () => {
    const a = new Date(2026, 3, 26, 0, 0, 1);
    const b = new Date(2026, 3, 26, 23, 59, 59);
    expect(dayKey(a)).toBe(dayKey(b));
  });
});
