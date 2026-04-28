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

// firstName returns the first whitespace-separated token of a display
// name ("Alice Smith" → "Alice"). Used by the group-label collapse in
// both ConversationRow (string input) and ConversationView (array of
// names) so the reduction lives in one place.
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

// firstNamesOnly takes a comma-joined list of full names and returns the
// same list with each entry collapsed to its first word. Used in group
// conversation labels — "Alice Smith, Bob Jones" → "Alice, Bob" — so the
// sidebar / header doesn't overflow on groups with several members.
//
// Single-token labels (no comma) are returned unchanged so custom group
// names like "Project Team" don't get clipped to "Project".
export function firstNamesOnly(label: string | undefined): string {
  if (!label) return '';
  if (!label.includes(',')) return label;
  return label.split(',').map(firstName).filter(Boolean).join(', ');
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

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

// ordinalSuffix returns "st", "nd", "rd", or "th" for the given day.
// 11–13 are exceptions ("th") even though they end in 1/2/3.
export function ordinalSuffix(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// formatLongDate renders a date like "August 3rd, 2016" — used in
// channel-creation and similar long-form intro copy.
export function formatLongDate(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  const month = MONTHS_LONG[d.getMonth()];
  const day = d.getDate();
  return `${month} ${day}${ordinalSuffix(day)}, ${d.getFullYear()}`;
}

// formatLongDateTime renders a timestamp like "Mar 26th at 18:33:01" — used
// in tooltips and any place a precise but human-readable timestamp is needed.
export function formatLongDateTime(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  const month = MONTHS_SHORT[d.getMonth()];
  const day = d.getDate();
  return `${month} ${day}${ordinalSuffix(day)} at ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// formatRelative renders a "time ago" style label — "just now", "2 hours ago",
// "3 days ago" — for tooltips where a precise timestamp would be too noisy.
export function formatRelative(input: Date | string | number, now: Date = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  const diffSec = Math.round((now.getTime() - d.getTime()) / 1000);
  if (diffSec < 45) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  const diffMonth = Math.round(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth} month${diffMonth === 1 ? '' : 's'} ago`;
  const diffYear = Math.round(diffMonth / 12);
  return `${diffYear} year${diffYear === 1 ? '' : 's'} ago`;
}

// formatDayHeading renders a calendar-day divider label: "Today", "Yesterday",
// or a date like "Mar 26th, 2026" once we cross a year boundary, "Mar 26th"
// within the current year. Used by the day-grouping divider in message lists.
export function formatDayHeading(input: Date | string | number, now: Date = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const month = MONTHS_SHORT[d.getMonth()];
  const day = d.getDate();
  const base = `${month} ${day}${ordinalSuffix(day)}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

// dayKey returns a YYYY-MM-DD string in local time, suitable for grouping
// a list of timestamped items into calendar days.
export function dayKey(input: Date | string | number): string {
  const d = input instanceof Date ? input : new Date(input);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
