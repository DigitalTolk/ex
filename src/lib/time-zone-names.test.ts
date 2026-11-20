import { afterEach, describe, expect, it, vi } from 'vitest';

// An engine on a zone database older than the Kyiv rename: it knows
// "Europe/Kiev" and rejects "Europe/Kyiv" (and a zone with no retired name,
// "Mars/Base", is unknown to it as to everyone). Modules are loaded fresh
// under it so no zone verdict from the real engine carries over.
function stubOldEngine(reports = 'Europe/Kiev', rejects = ['Europe/Kyiv']) {
  const Real = Intl.DateTimeFormat;
  const Old = function (locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    if (options?.timeZone && rejects.includes(options.timeZone)) throw new RangeError(`Invalid time zone specified: ${options.timeZone}`);
    const format = new Real(locales, options);
    if (!options?.timeZone) {
      const resolved = format.resolvedOptions();
      format.resolvedOptions = () => ({ ...resolved, timeZone: reports });
    }
    return format;
  } as unknown as typeof Intl.DateTimeFormat;
  vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: Old, supportedValuesOf: () => ['Europe/Kiev', 'Europe/Stockholm'] });
  vi.resetModules();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('time zones on an engine that predates a rename', () => {
  it('reports the zone under the name the engine can format', async () => {
    stubOldEngine();
    const { localTimeZone } = await import('@/lib/user-time');
    expect(localTimeZone()).toBe('Europe/Kiev');
  });

  it('formats a stored current name through the retired one it knows', async () => {
    stubOldEngine();
    const { formatLocalTime, formatTimeZoneDelta, formatTimeZoneName, isValidTimeZone, timeZoneOffsetMinutes } =
      await import('@/lib/user-time');
    const { inputValueForDate } = await import('@/lib/datetime-input');
    const at = new Date('2026-07-01T09:00:00Z');
    expect(isValidTimeZone('Europe/Kyiv')).toBe(true);
    expect(formatTimeZoneName('Europe/Kyiv')).toBe('Kyiv, Europe');
    expect(timeZoneOffsetMinutes('Europe/Kyiv', at)).toBe(180);
    expect(formatLocalTime('Europe/Kyiv', at)).toBe(formatLocalTime('Europe/Kiev', at));
    expect(inputValueForDate(at, 'Europe/Kyiv')).toBe('2026-07-01T12:00');
    expect(formatTimeZoneDelta('Europe/Kyiv', 'Europe/Kiev')).toBeNull();
    // A zone nobody knows stays invalid.
    expect(isValidTimeZone('Mars/Base')).toBe(false);
  });

  it('offers zones in the schedule picker under names the engine knows', async () => {
    stubOldEngine();
    const { timeZoneOptions } = await import('@/lib/schedule');
    expect(timeZoneOptions('Europe/Kiev')).toEqual(['UTC', 'Europe/Kiev', 'Europe/Stockholm']);
  });
});

describe('engineTimeZone', () => {
  it('leaves a zone the engine knows by neither name as given', async () => {
    stubOldEngine('UTC', ['Europe/Kyiv', 'Europe/Kiev']);
    const { engineTimeZone } = await import('@/lib/time-zone-names');
    expect(engineTimeZone('Europe/Kyiv')).toBe('Europe/Kyiv');
  });

  it('keeps a name the engine knows, and the runtime zone as empty', async () => {
    const { engineTimeZone } = await import('@/lib/time-zone-names');
    expect(engineTimeZone('Europe/Kyiv')).toBe('Europe/Kyiv');
    expect(engineTimeZone('')).toBe('');
    // Unknown, with or without a retired spelling to fall back on.
    expect(engineTimeZone('Mars/Base')).toBe('Mars/Base');
  });
});
