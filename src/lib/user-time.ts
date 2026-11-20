import { partsInTimeZone } from '@/lib/datetime-input';
import { canonicalTimeZone, currentTimeZoneName, engineAccepts, engineTimeZone } from '@/lib/time-zone-names';

export { canonicalTimeZone } from '@/lib/time-zone-names';

// The formatters here are built once and reused (per zone where they take
// one): the members directory formats every member's last-seen time, local
// time and zone on each render, and a formatter built per call made a
// 500-member page take most of a second on a phone — and as long again per
// keystroke in its search.
const lastSeenFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatLastSeen(lastSeenAt?: string, online?: boolean): string | null {
  if (online) return 'now';
  if (!lastSeenAt) return null;
  const at = new Date(lastSeenAt);
  return Number.isNaN(at.getTime()) ? null : lastSeenFormat.format(at);
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

// formatLocalTime is the time it is in a (valid) zone, as a clock reads in
// the viewer's locale: "3:04 PM".
export function formatLocalTime(timeZone: string, at = new Date()): string {
  let format = clockFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, { timeZone: engineTimeZone(timeZone), hour: 'numeric', minute: '2-digit' });
    clockFormats.set(timeZone, format);
  }
  return format.format(at);
}

// localTimeZone is the viewer's IANA zone — what "8am" means to them — under
// its current name. A browser that can't report one gives '' and the server
// decides (the profile's zone, then UTC).
export function localTimeZone(): string {
  try {
    return currentTimeZoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  } catch {
    return '';
  }
}

// isValidTimeZone: a zone this engine can format, under the name given or,
// for a renamed zone, the retired one it knows.
export function isValidTimeZone(timeZone?: string | null): timeZone is string {
  return !!timeZone && engineAccepts(engineTimeZone(timeZone));
}

export function formatTimeZoneName(timeZone?: string): string | null {
  if (!isValidTimeZone(timeZone)) return null;
  const parts = canonicalTimeZone(timeZone).split('/');
  if (parts.length === 1) return parts[0].replaceAll('_', ' ');
  /* istanbul ignore next -- parts comes from a non-empty string split, so .at(-1) is always a string; the ?? timeZone arm is defensive. */
  const city = parts.at(-1)?.replaceAll('_', ' ') ?? timeZone;
  const region = parts.slice(0, -1).join('/').replaceAll('_', ' ');
  return `${city}, ${region}`;
}

export function timeZoneOffsetMinutes(timeZone: string, at = new Date()): number | null {
  try {
    // Reuse the shared parts extractor (same formatToParts + numeric-field
    // pull); it throws on an invalid IANA zone, which the catch turns into null.
    const p = partsInTimeZone(at, timeZone);
    const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUTC - at.getTime()) / 60000);
  } catch {
    return null;
  }
}

export function formatTimeZoneDelta(
  userTimeZone?: string,
  local = localTimeZone(),
): string | null {
  if (!userTimeZone) return null;
  if (!local || local === userTimeZone) return null;
  const userOffset = timeZoneOffsetMinutes(userTimeZone);
  const localOffset = timeZoneOffsetMinutes(local);
  if (userOffset === null || localOffset === null) return null;
  const deltaMinutes = userOffset - localOffset;
  if (deltaMinutes === 0) return null;
  const abs = Math.abs(deltaMinutes);
  const hours = abs / 60;
  const amount = `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hr${hours === 1 ? '' : 's'}`;
  return `${amount} ${deltaMinutes > 0 ? 'ahead' : 'behind'}`;
}
