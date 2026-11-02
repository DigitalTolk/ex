// Shared helpers for `<input type="datetime-local">` values. Used by the status
// "clear after custom time" picker (timezone-aware, in the user's chosen zone)
// and the message reminder picker (browser-local). Centralised so the
// zero-padded `YYYY-MM-DDTHH:mm` format and the timezone math live in one place.

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// One formatter per named zone, built on first use: the members directory
// reads every member's offset on each render. The runtime's own zone ('') is
// built per call, so it follows the device when that changes zone.
const partsFormats = new Map<string, Intl.DateTimeFormat>();

function partsFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = partsFormats.get(timeZone);
  if (cached) return cached;
  const format = new Intl.DateTimeFormat('en-CA', {
    // An empty string is an invalid IANA zone and throws RangeError; coerce it
    // to undefined so Intl falls back to the runtime's own zone instead.
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  if (timeZone) partsFormats.set(timeZone, format);
  return format;
}

// partsInTimeZone breaks a Date into calendar fields (incl. seconds) as observed
// in the given IANA time zone.
export function partsInTimeZone(date: Date, timeZone: string) {
  const parts = partsFormat(timeZone).formatToParts(date);
  /* v8 ignore next -- the requested part always exists for a valid date/timezone; the ?? 0 fallback is defensive */
  /* istanbul ignore next -- the requested part always exists for a valid date/timezone; the ?? 0 fallback is defensive */
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

// inputValueForDate renders a Date as the `YYYY-MM-DDTHH:mm` string a
// datetime-local input expects, in the given time zone.
export function inputValueForDate(date: Date, timeZone: string): string {
  const p = partsInTimeZone(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
