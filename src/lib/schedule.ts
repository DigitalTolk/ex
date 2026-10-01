// Scheduled agent orders: building the five-field cron spec the backend
// stores (internal/cron) from the UI's cadence + time pickers, and rendering
// a stored spec back as a sentence.
//
// The UI deliberately offers a few cadences rather than a cron box: "every
// weekday at 08:00" is what people actually want, and a raw cron field would
// make the common case feel like configuration. Specs the picker can't
// express still render readably here, so a spec written by other means (or a
// future advanced field) never shows as gibberish.

export type Cadence = 'daily' | 'weekdays' | 'weekly';

export const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

// localTimeZone is the viewer's IANA zone — what "8am" means to them. Sent on
// create so a schedule is anchored to their zone rather than the server's.
// A browser that can't report one falls back to the server's default (the
// creator's profile timezone, then UTC).
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

// timeZoneOptions is what the form's zone picker offers: every IANA zone the
// browser knows, plus UTC and the given zones (the viewer's own, an edited
// order's), which the list can omit — V8 leaves out "UTC" and reports some
// zones under legacy names.
export function timeZoneOptions(...current: string[]): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older engine: the picker still offers UTC and the given zones.
  }
  const extra = [...new Set([...current, 'UTC'])].filter((z) => z && !zones.includes(z));
  return [...extra, ...zones];
}

// cronFromParts builds the spec: "08:00" + weekdays → "0 8 * * 1-5".
// An unparseable time falls back to 09:00 rather than emitting a spec the
// backend would reject.
export function cronFromParts(cadence: Cadence, time: string, weekday = 1): string {
  // Match the shape first: Number('') is 0, so a bare ":30" would otherwise
  // pass the range checks and quietly schedule midnight.
  const match = /^(\d{1,2}):(\d{2})$/.exec((time || '').trim());
  let h = match ? Number(match[1]) : NaN;
  let m = match ? Number(match[2]) : NaN;
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(m) || m < 0 || m > 59) {
    h = 9;
    m = 0;
  }
  const dow = cadence === 'weekdays' ? '1-5' : cadence === 'weekly' ? String(weekday) : '*';
  return `${m} ${h} * * ${dow}`;
}

// describeSchedule renders a stored spec as a sentence ("every weekday at
// 08:00"). Mirrors cron.Describe server-side; both fall back to the raw spec
// for shapes too rich to phrase.
export function describeSchedule(spec: string | undefined, tz?: string): string {
  const zone = tz ? ` (${tz})` : '';
  const parts = (spec ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return spec ?? '';
  const [min, hour, dom, month, dow] = parts;
  const m = Number(min);
  const h = Number(hour);
  const simpleTime =
    Number.isInteger(m) && Number.isInteger(h) && m >= 0 && m < 60 && h >= 0 && h < 24;
  if (!simpleTime || dom !== '*' || month !== '*') return `${spec}${zone}`;
  const at = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (dow === '*') return `every day at ${at}${zone}`;
  if (dow === '1-5') return `every weekday at ${at}${zone}`;
  const days = dow
    .split(',')
    .map((d) => WEEKDAY_NAMES[Number(d) % 7])
    .filter(Boolean);
  if (days.length === 0) return `${spec}${zone}`;
  return `every ${days.join(', ')} at ${at}${zone}`;
}

// partsFromCron reverses cronFromParts so an existing order opens in the
// picker with its own cadence selected. Specs outside the picker's grammar
// return null — the caller shows them read-only.
export function partsFromCron(
  spec: string | undefined,
): { cadence: Cadence; time: string; weekday: number } | null {
  const parts = (spec ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  const m = Number(min);
  const h = Number(hour);
  if (!Number.isInteger(m) || !Number.isInteger(h) || dom !== '*' || month !== '*') return null;
  if (m < 0 || m > 59 || h < 0 || h > 23) return null;
  const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  if (dow === '*') return { cadence: 'daily', time, weekday: 1 };
  if (dow === '1-5') return { cadence: 'weekdays', time, weekday: 1 };
  const d = Number(dow);
  if (Number.isInteger(d) && d >= 0 && d <= 6) return { cadence: 'weekly', time, weekday: d };
  return null;
}

// suggestChannelName turns the instruction into a plausible channel name so
// the common path is "type what you want, press Schedule" rather than
// inventing a name. Deliberately crude: lowercase words, stopwords dropped,
// three words max — a starting point the user can overwrite, not a guess
// that must be right.
const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'from', 'to', 'in', 'on', 'at', 'by', 'with',
  'me', 'my', 'our', 'us', 'it', 'its', 'this', 'that', 'each', 'every', 'all',
  'post', 'send', 'give', 'pull', 'get', 'fetch', 'show', 'tell', 'make', 'run', 'summarise',
  'summarize', 'report', 'please',
]);

export function suggestChannelName(instruction: string): string {
  const words = (instruction || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w));
  if (words.length === 0) return '';
  return words.slice(0, 3).join('-').slice(0, 64);
}
