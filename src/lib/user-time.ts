import { partsInTimeZone } from '@/lib/datetime-input';

export function formatLastSeen(lastSeenAt?: string, online?: boolean): string | null {
  if (online) return 'now';
  if (!lastSeenAt) return null;
  return new Date(lastSeenAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function localTimeZone(): string {
  /* istanbul ignore next -- resolvedOptions().timeZone is always a non-empty IANA string in every supported runtime; the || '' fallback is defensive. */
  return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
}

export function isValidTimeZone(timeZone?: string | null): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function formatTimeZoneName(timeZone?: string): string | null {
  if (!isValidTimeZone(timeZone)) return null;
  const parts = timeZone.split('/');
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
  localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  if (!userTimeZone) return null;
  const local = localTimeZone;
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
