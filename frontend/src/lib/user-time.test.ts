import { describe, expect, it } from 'vitest';
import {
  formatLastSeen,
  formatTimeZoneName,
  formatTimeZoneDelta,
  isValidTimeZone,
  localTimeZone,
  timeZoneOffsetMinutes,
} from './user-time';

describe('user-time helpers', () => {
  it('formats online users as now and omits missing offline timestamps', () => {
    expect(formatLastSeen('2026-05-03T10:00:00.000Z', true)).toBe('now');
    expect(formatLastSeen(undefined, false)).toBeNull();
  });

  it('formats offline last-seen timestamps', () => {
    expect(formatLastSeen('2026-05-03T10:00:00.000Z', false)).toEqual(expect.any(String));
  });

  it('computes timezone offsets and handles invalid timezone names', () => {
    expect(timeZoneOffsetMinutes('UTC', new Date('2026-01-01T00:00:00.000Z'))).toBe(0);
    expect(timeZoneOffsetMinutes('not-a-zone')).toBeNull();
  });

  it('validates IANA timezone names', () => {
    expect(isValidTimeZone('Europe/Stockholm')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('formats ahead and behind timezone deltas', () => {
    expect(formatTimeZoneDelta('Europe/Stockholm', 'UTC')).toMatch(/ahead/);
    expect(formatTimeZoneDelta('Europe/Stockholm', 'Europe/London')).toBe('1 hr ahead');
    expect(formatTimeZoneDelta('America/New_York', 'UTC')).toMatch(/behind/);
    expect(formatTimeZoneDelta('Australia/Adelaide', 'UTC')).toBe('9.5 hrs ahead');
    expect(formatTimeZoneDelta('Asia/Kolkata', 'UTC')).toBe('5.5 hrs ahead');
    expect(formatTimeZoneDelta('UTC', 'UTC')).toBeNull();
  });

  it('returns null for empty timezone input', () => {
    expect(formatTimeZoneDelta()).toBeNull();
    expect(formatTimeZoneDelta('UTC', '')).toBeNull();
    expect(formatTimeZoneDelta('not-a-zone', 'UTC')).toBeNull();
  });

  it('detects the browser timezone', () => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    expect(localTimeZone()).toBe(detected);
  });

  it('formats IANA timezone names for display', () => {
    expect(formatTimeZoneName('America/New_York')).toBe('New York, America');
    expect(formatTimeZoneName('UTC')).toBe('UTC');
    expect(formatTimeZoneName('Not/AZone')).toBeNull();
    expect(formatTimeZoneName()).toBeNull();
  });
});
