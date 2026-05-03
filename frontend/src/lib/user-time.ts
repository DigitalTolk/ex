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
  return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
}

export function formatTimeZoneName(timeZone?: string): string | null {
  if (!timeZone) return null;
  const parts = timeZone.split('/');
  if (parts.length === 1) return parts[0].replaceAll('_', ' ');
  const city = parts.at(-1)?.replaceAll('_', ' ') ?? timeZone;
  const region = parts.slice(0, -1).join('/').replaceAll('_', ' ');
  return `${city}, ${region}`;
}

export function timeZoneOffsetMinutes(timeZone: string, at = new Date()): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const asUTC = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour') % 24,
      value('minute'),
      value('second'),
    );
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
  const hours = Math.round(abs / 60);
  const amount = `${hours} hr${hours === 1 ? '' : 's'}`;
  return `${amount} ${deltaMinutes > 0 ? 'ahead' : 'behind'}`;
}
