import { describe, it, expect } from 'vitest';
import { pad, inputValueForDate, partsInTimeZone } from '@/lib/datetime-input';

describe('datetime-input', () => {
  it('pads to two digits', () => {
    expect(pad(3)).toBe('03');
    expect(pad(12)).toBe('12');
  });

  it('formats a datetime-local value in a given zone', () => {
    // UTC noon → the same wall-clock in UTC.
    expect(inputValueForDate(new Date('2026-07-01T12:00:00Z'), 'UTC')).toBe('2026-07-01T12:00');
  });

  it('falls back to the runtime zone (no throw) when the timezone is empty', () => {
    // An empty string is an invalid IANA zone; the guard coerces it to undefined
    // so Intl uses the runtime default instead of throwing RangeError.
    const d = new Date('2026-07-01T12:00:00Z');
    expect(() => partsInTimeZone(d, '')).not.toThrow();
    expect(inputValueForDate(d, '')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
