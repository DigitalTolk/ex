import { describe, expect, it } from 'vitest';
import {
  formatLastSeen,
  isValidTimeZone,
  formatTimeZoneName,
  timeZoneOffsetMinutes,
  formatTimeZoneDelta,
} from './user-time';

// Browser-gate coverage for the pure time/timezone helpers. The jsdom
// user-time.test.ts exercises these, but the file only has a jsdom test and
// is excluded from that gate, so the branches register as uncovered in the
// browser view.

describe('user-time helpers (browser)', () => {
  it('formatLastSeen handles online / missing / timestamped states', () => {
    expect(formatLastSeen(undefined, true)).toBe('now');
    expect(formatLastSeen(undefined, false)).toBeNull();
    expect(typeof formatLastSeen('2026-05-01T10:00:00Z', false)).toBe('string');
  });

  it('isValidTimeZone accepts real zones and rejects junk / empty', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Definitely/NotAZone')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('formatTimeZoneName renders single- and multi-segment zone names', () => {
    expect(formatTimeZoneName('UTC')).toBe('UTC');
    expect(formatTimeZoneName('America/New_York')).toBe('New York, America');
    expect(formatTimeZoneName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires, America/Argentina');
    expect(formatTimeZoneName('Not/AZone')).toBeNull();
  });

  it('timeZoneOffsetMinutes returns a number for valid zones and null for junk', () => {
    const at = new Date('2026-06-01T12:00:00Z'); // clean instant (no sub-minute ms)
    expect(timeZoneOffsetMinutes('UTC', at)).toBe(0);
    expect(timeZoneOffsetMinutes('Asia/Tokyo', at)).toBe(540);
    expect(timeZoneOffsetMinutes('Definitely/NotAZone', at)).toBeNull();
  });

  it('formatTimeZoneDelta returns null for absent / identical / same-offset zones', () => {
    expect(formatTimeZoneDelta(undefined)).toBeNull();
    expect(formatTimeZoneDelta('UTC', 'UTC')).toBeNull();
    // Different name, identical offset → no meaningful delta.
    expect(formatTimeZoneDelta('Etc/UTC', 'UTC')).toBeNull();
  });

  it('formatTimeZoneDelta describes ahead/behind with singular/plural/fractional hours', () => {
    // Tokyo (+9, no DST) vs UTC → 9 hrs ahead.
    expect(formatTimeZoneDelta('Asia/Tokyo', 'UTC')).toBe('9 hrs ahead');
    // Reverse → behind.
    expect(formatTimeZoneDelta('UTC', 'Asia/Tokyo')).toBe('9 hrs behind');
    // Lagos (+1, no DST) → singular "hr".
    expect(formatTimeZoneDelta('Africa/Lagos', 'UTC')).toBe('1 hr ahead');
    // Kolkata (+5:30, no DST) → fractional hours.
    expect(formatTimeZoneDelta('Asia/Kolkata', 'UTC')).toBe('5.5 hrs ahead');
  });
});
