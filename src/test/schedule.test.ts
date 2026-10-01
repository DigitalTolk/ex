import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  cronFromParts,
  describeSchedule,
  localTimeZone,
  partsFromCron,
  suggestChannelName,
  timeZoneOptions,
} from '@/lib/schedule';

describe('timeZoneOptions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('offers every browser zone, plus UTC and the viewer zone when the list omits them', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue(['Asia/Tokyo', 'Europe/Stockholm']);
    expect(timeZoneOptions('Asia/Kolkata')).toEqual([
      'Asia/Kolkata',
      'UTC',
      'Asia/Tokyo',
      'Europe/Stockholm',
    ]);
    // Already listed → not duplicated; empty current adds nothing.
    expect(timeZoneOptions('Asia/Tokyo')).toEqual(['UTC', 'Asia/Tokyo', 'Europe/Stockholm']);
    expect(timeZoneOptions('')).toEqual(['UTC', 'Asia/Tokyo', 'Europe/Stockholm']);
  });

  it('still offers UTC and the viewer zone on an engine without the zone list', () => {
    vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => {
      throw new TypeError('unsupported');
    });
    expect(timeZoneOptions('Asia/Kolkata')).toEqual(['Asia/Kolkata', 'UTC']);
  });
});

describe('cronFromParts', () => {
  it('builds the spec the backend stores', () => {
    expect(cronFromParts('weekdays', '08:00')).toBe('0 8 * * 1-5');
    expect(cronFromParts('daily', '17:30')).toBe('30 17 * * *');
    expect(cronFromParts('weekly', '09:15', 3)).toBe('15 9 * * 3');
  });

  it('falls back to 09:00 rather than emitting a spec the backend rejects', () => {
    for (const bad of ['', 'lunchtime', '25:00', '08:99', '8', ':30']) {
      expect(cronFromParts('daily', bad)).toBe('0 9 * * *');
    }
  });
});

describe('describeSchedule', () => {
  it('phrases the shapes the picker produces', () => {
    expect(describeSchedule('0 8 * * 1-5', 'Europe/Stockholm')).toBe(
      'every weekday at 08:00 (Europe/Stockholm)',
    );
    expect(describeSchedule('30 17 * * *')).toBe('every day at 17:30');
    expect(describeSchedule('0 9 * * 1', 'UTC')).toBe('every Mon at 09:00 (UTC)');
    expect(describeSchedule('0 9 * * 1,4', 'UTC')).toBe('every Mon, Thu at 09:00 (UTC)');
  });

  it('falls back to the raw spec for richer shapes and junk', () => {
    expect(describeSchedule('*/15 * * * *', 'UTC')).toBe('*/15 * * * * (UTC)');
    expect(describeSchedule('0 9 1 * *', 'UTC')).toBe('0 9 1 * * (UTC)');
    expect(describeSchedule('0 9 * 3 *', 'UTC')).toBe('0 9 * 3 * (UTC)');
    expect(describeSchedule('x 9 * * *', 'UTC')).toBe('x 9 * * * (UTC)');
    expect(describeSchedule('nonsense')).toBe('nonsense');
    expect(describeSchedule(undefined)).toBe('');
    // A weekday list that resolves to nothing readable stays raw.
    expect(describeSchedule('0 9 * * x', 'UTC')).toBe('0 9 * * x (UTC)');
  });
});

describe('partsFromCron', () => {
  it('round-trips the picker grammar', () => {
    expect(partsFromCron('0 8 * * 1-5')).toEqual({ cadence: 'weekdays', time: '08:00', weekday: 1 });
    expect(partsFromCron('30 17 * * *')).toEqual({ cadence: 'daily', time: '17:30', weekday: 1 });
    expect(partsFromCron('15 9 * * 3')).toEqual({ cadence: 'weekly', time: '09:15', weekday: 3 });
    // Whatever the picker builds, it can read back.
    expect(partsFromCron(cronFromParts('weekly', '06:05', 0))).toEqual({
      cadence: 'weekly',
      time: '06:05',
      weekday: 0,
    });
  });

  it('returns null for specs outside the picker grammar', () => {
    for (const spec of ['*/15 * * * *', '0 9 1 * *', '0 9 * 3 *', 'x 9 * * *', '0 8 * *', undefined, '0 9 * * 1-3']) {
      expect(partsFromCron(spec)).toBeNull();
    }
    expect(partsFromCron('99 9 * * *')).toBeNull();
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

describe('suggestChannelName', () => {
  it('turns an instruction into a plausible channel name', () => {
    expect(suggestChannelName('Post yesterday revenue numbers from metabase')).toBe(
      'yesterday-revenue-numbers',
    );
    // Stopwords and short words drop out; punctuation is stripped.
    expect(suggestChannelName('Summarise the support tickets, please!')).toBe('support-tickets');
    expect(suggestChannelName('give me my standup digest')).toBe('standup-digest');
  });

  it('returns empty when there is nothing to name it after', () => {
    for (const junk of ['', '   ', 'the a an', 'to me', '!!! ???']) {
      expect(suggestChannelName(junk)).toBe('');
    }
  });

  it('stays within a channel-name length budget', () => {
    expect(suggestChannelName('absolutely'.repeat(20)).length).toBeLessThanOrEqual(64);
  });
});
