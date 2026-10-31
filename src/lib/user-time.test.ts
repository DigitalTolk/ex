import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatLastSeen,
  formatLocalTime,
  formatTimeZoneName,
  formatTimeZoneDelta,
  isValidTimeZone,
  localTimeZone,
  timeZoneOffsetMinutes,
} from './user-time';

describe('user-time helpers', () => {
  afterEach(() => vi.useRealTimers());

  it('formats online users as now and omits missing offline timestamps', () => {
    expect(formatLastSeen('2026-05-03T10:00:00.000Z', true)).toBe('now');
    expect(formatLastSeen(undefined, false)).toBeNull();
  });

  it('formats offline last-seen timestamps', () => {
    expect(formatLastSeen('2026-05-03T10:00:00.000Z', false)).toEqual(expect.any(String));
    expect(formatLastSeen('not a time', false)).toBeNull();
  });

  it('formats the time it is in a zone', () => {
    expect(formatLocalTime('UTC', new Date('2026-01-01T15:04:00Z'))).toMatch(/(3:04|15:04)/);
    expect(formatLocalTime('Asia/Tokyo', new Date('2026-01-01T15:04:00Z'))).toMatch(/(12:04|0?0:04)/);
  });

  // The members directory formats every member's last-seen time, local time
  // and zone on each render: building a formatter per call made a 500-member
  // page take most of a second on a phone, and as long again per keystroke in
  // its search.
  it('reuses one formatter per zone', () => {
    const formatMember = () => {
      isValidTimeZone('Asia/Tokyo');
      formatTimeZoneName('Asia/Tokyo');
      formatLocalTime('Asia/Tokyo');
      formatTimeZoneDelta('Asia/Tokyo', 'Europe/Stockholm');
      formatLastSeen('2026-05-03T10:00:00.000Z', false);
    };
    formatMember();
    const built = vi.spyOn(Intl, 'DateTimeFormat');
    formatMember();
    expect(built).not.toHaveBeenCalled();
    built.mockRestore();
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
    // Offsets move with daylight saving (Adelaide is +9.5 in July, +10.5 from
    // October), so pin "now" to a date where every zone below is stable.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-01T12:00:00Z'));
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
describe('localTimeZone', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports the viewer zone so "8am" means their 8am', () => {
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Asia/Kolkata' }) }),
    });
    expect(localTimeZone()).toBe('Asia/Kolkata');
  });

  it('degrades to empty (server decides) when the browser cannot say', () => {
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: undefined }) }),
    });
    expect(localTimeZone()).toBe('');
    vi.stubGlobal('Intl', {
      DateTimeFormat: () => {
        throw new Error('no Intl');
      },
    });
    expect(localTimeZone()).toBe('');
  });
});

