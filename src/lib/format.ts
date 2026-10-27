import { differenceInCalendarDays, format as formatDate, formatDistanceStrict, isSameYear, isValid } from 'date-fns';

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// extractURLs returns http(s) URLs that appear in plain text — used by
// the link-unfurl renderer. Skips fenced code blocks and inline code
// spans (devs paste real URLs there and a preview would be noise) and
// strips trailing sentence punctuation that's almost never part of the
// URL itself. The first URL only is enough for our preview UX, but we
// return all matches so the caller can de-dupe / cap.
const URL_RE = /https?:\/\/[^\s<>"`]+/g;
const TRAILING_PUNCT_RE = /[.,!?;:)\]]+$/;
export function extractURLs(body: string): string[] {
  if (!body) return [];
  const urls: string[] = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('```', i)) {
      const end = body.indexOf('```', i + 3);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (body[i] === '`') {
      const end = body.indexOf('`', i + 1);
      if (end === -1) break;
      i = end + 1;
      continue;
    }
    let next = body.length;
    const fence = body.indexOf('```', i);
    if (fence !== -1 && fence < next) next = fence;
    const tick = body.indexOf('`', i);
    if (tick !== -1 && tick < next) next = tick;
    const segment = body.slice(i, next);
    for (const m of segment.matchAll(URL_RE)) {
      urls.push(m[0].replace(TRAILING_PUNCT_RE, ''));
    }
    i = next;
  }
  return urls;
}

// Leading name words people are not called by: "Muhammad" (in its common
// spellings and abbreviations) opens a great many Pakistani names, and
// "Muhammad Ali Khan" goes by Ali Khan. Keep in step with namePrefixes in
// internal/model/name.go.
const NAME_PREFIXES = new Set(['muhammad', 'muhammed', 'mohammad', 'mohammed', 'mohamed', 'mohamad', 'muhamad', 'mohd', 'md']);

export function isNamePrefix(word: string): boolean {
  return NAME_PREFIXES.has(word.toLowerCase().replace(/\.$/, ''));
}

// shortName returns the name a person goes by: the first word of their
// display name ("Alice Smith" → "Alice"), or — for a name opening with a
// name prefix — everything after it ("Muhammad Ali Khan" → "Ali Khan"), since
// so many go by Ali that the next word alone would still name a crowd. A name
// that is nothing but prefixes keeps its first word. Used by the group-label
// collapse in both ConversationRow (string input) and ConversationView (array
// of names) so the reduction lives in one place.
export function shortName(name: string): string {
  const words = name.trim().split(/\s+/);
  const rest = words.findIndex((w) => !isNamePrefix(w));
  if (rest <= 0) return words.slice(0, 1).join('');
  return words.slice(rest).join(' ');
}

// shortNamesOnly takes a comma-joined list of full names and returns the
// same list with each entry collapsed to its short name. Used in group
// conversation labels — "Alice Smith, Bob Jones" → "Alice, Bob" — so the
// sidebar / header doesn't overflow on groups with several members.
//
// Single-token labels (no comma) are returned unchanged so custom group
// names like "Project Team" don't get clipped to "Project".
export function shortNamesOnly(label: string | undefined): string {
  if (!label) return '';
  if (!label.includes(',')) return label;
  return label.split(',').map(shortName).filter(Boolean).join(', ');
}

export const KIB = 1024;
export const MIB = 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < KIB) return `${n} B`;
  if (n < MIB) return `${(n / KIB).toFixed(1)} KB`;
  return `${(n / MIB).toFixed(1)} MB`;
}

export function bytesToMib(bytes: number): number {
  return Math.round(bytes / MIB);
}

export function mibToBytes(mib: number): number {
  return Math.floor(mib * MIB);
}

// Date wording below is English on purpose (the app's copy is English);
// date-fns does the calendar math, ordinals and pluralisation.
type DateInput = Date | string | number;

// date-fns throws on a date that doesn't parse; one bad timestamp must not
// take the message list down, so it formats to nothing instead.
function format(input: DateInput, pattern: string): string {
  const d = new Date(input);
  return isValid(d) ? formatDate(d, pattern) : '';
}

// formatLongDate renders a date like "August 3rd, 2016" — used in
// channel-creation and similar long-form intro copy.
export function formatLongDate(input: DateInput): string {
  return format(input, 'MMMM do, yyyy');
}

// formatLongDateTime renders a timestamp like "Mar 26th at 18:33:01" — used
// in tooltips and any place a precise but human-readable timestamp is needed.
// Outside the current year it carries the year, "Mar 26th, 2017 at 18:33:01",
// so an old (e.g. imported) message never reads as this year's.
export function formatLongDateTime(input: DateInput, now: Date = new Date()): string {
  return format(input, isSameYear(input, now) ? "MMM do 'at' HH:mm:ss" : "MMM do, yyyy 'at' HH:mm:ss");
}

// The unit a relative time is worded in is picked on the ROUNDED amount, so
// a gap just short of a boundary reads "1 hour ago", never "60 minutes ago".
const RELATIVE_UNITS = [
  { unit: 'minute', minutes: 1, below: 60 },
  { unit: 'hour', minutes: 60, below: 24 },
  { unit: 'day', minutes: 1440, below: 30 },
  { unit: 'month', minutes: 43_200, below: 12 },
] as const;

// formatRelative renders a "time ago" style label — "just now", "2 hours ago",
// "3 days ago" — for tooltips where a precise timestamp would be too noisy.
export function formatRelative(input: DateInput, now: Date = new Date()): string {
  const minutes = (now.getTime() - new Date(input).getTime()) / 60_000;
  if (Number.isNaN(minutes)) return '';
  if (Math.round(minutes * 60) < 45) return 'just now';
  const unit = RELATIVE_UNITS.find((u) => Math.round(minutes / u.minutes) < u.below)?.unit ?? 'year';
  return formatDistanceStrict(input, now, { addSuffix: true, roundingMethod: 'round', unit });
}

// calendarDaysAgo counts local calendar days between input and now: 0 for
// today, 1 for yesterday (whatever the hour), negative for the future.
export function calendarDaysAgo(input: DateInput, now: Date): number {
  return differenceInCalendarDays(now, input);
}

// formatDayHeading renders a calendar-day divider label: "Today", "Yesterday",
// or a date like "Mar 26th, 2026" once we cross a year boundary, "Mar 26th"
// within the current year. Used by the day-grouping divider in message lists.
export function formatDayHeading(input: DateInput, now: Date = new Date()): string {
  const diffDays = calendarDaysAgo(input, now);
  if (Number.isNaN(diffDays)) return '';
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return format(input, isSameYear(input, now) ? 'MMM do' : 'MMM do, yyyy');
}

// dayKey returns a YYYY-MM-DD string in local time, suitable for grouping
// a list of timestamped items into calendar days (and as the value a date
// input takes).
export function dayKey(input: DateInput): string {
  return format(input, 'yyyy-MM-dd') || 'NaN-NaN-NaN';
}
