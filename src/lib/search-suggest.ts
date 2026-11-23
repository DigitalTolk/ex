import { addDays, foldName, resolveDay, resolveFromPerson, resolveInPlace, type SearchModifier } from '@/lib/search-modifiers';

// Suggestions for the search modifiers while one is being typed, as
// Mattermost offers them: "from:c" lists people, "in:o" lists your channels
// and DMs, and picking one completes the word with a value the search page
// reads back to that same person or chat (see search-modifiers).

export interface ActiveModifier {
  key: SearchModifier;
  // What has been typed after the colon (an opening quote dropped).
  partial: string;
  // Where the modifier starts in the query.
  start: number;
}

// The modifier being typed: the query's last word, while it starts with
// from: or in: (a quoted value may hold spaces).
export function activeModifier(q: string): ActiveModifier | null {
  const m = /(^|\s)(from|in|on|before|after):(?:"([^"]*)|([^\s"]*))$/i.exec(q);
  if (!m) return null;
  return { key: m[2].toLowerCase() as SearchModifier, partial: m[3] ?? m[4], start: m.index + m[1].length };
}

// completeModifier puts the picked value in place of the modifier being
// typed, ready for the next word.
export function completeModifier(q: string, active: ActiveModifier, value: string): string {
  return `${q.slice(0, active.start)}${active.key}:${value} `;
}

const quote = (s: string) => (/\s/.test(s) ? `"${s}"` : s);

interface Person {
  id: string;
  displayName: string;
  email?: string;
}

// personHandle is the shortest way to write this person that finds them and
// no one else: a first name, the full name, then the email.
export function personHandle<P extends Person>(person: P, people: P[]): string {
  const first = person.displayName.trim().split(/\s+/)[0];
  const local = (person.email ?? '').split('@')[0];
  for (const candidate of [first, person.displayName.trim(), local, person.email ?? '']) {
    if (candidate && resolveFromPerson(candidate, people)?.id === person.id) return quote(candidate);
  }
  return quote(person.displayName.trim());
}

export interface Place {
  id: string;
  name: string;
  kind: 'channel' | 'conversation';
}

// placeHandle writes a channel as ~name and a DM by its name.
export function placeHandle(place: Place, places: Place[]): string {
  const written = place.kind === 'channel' ? `~${place.name}` : place.name;
  return resolveInPlace(written, places)?.id === place.id ? quote(written) : quote(place.name);
}

// How well a name matches what was typed: its start, then a later word's
// start, then anywhere in it; -1 for no match.
function rank(typed: string, ...names: string[]): number {
  let best = -1;
  for (const raw of names) {
    const name = foldName(raw);
    if (!name) continue;
    const r = name.startsWith(typed) ? 0 : name.split(/[\s._@-]+/).some((w) => w.startsWith(typed)) ? 1 : name.includes(typed) ? 2 : -1;
    if (r >= 0 && (best < 0 || r < best)) best = r;
  }
  return best;
}

function bestMatches<T>(typed: string, items: T[], names: (item: T) => string[], label: (item: T) => string, limit: number): T[] {
  const t = foldName(typed);
  return items
    .map((item) => ({ item, r: t ? rank(t, ...names(item)) : 0 }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || label(a.item).localeCompare(label(b.item)))
    .slice(0, limit)
    .map((x) => x.item);
}

export const MODIFIER_SUGGESTIONS = 8;

export function suggestPeople<P extends Person>(typed: string, people: P[], limit = MODIFIER_SUGGESTIONS): P[] {
  // A name and the part of the email before the @: every address shares its
  // domain, so matching it would list everyone for a "c".
  return bestMatches(typed, people, (p) => [p.displayName, (p.email ?? '').split('@')[0]], (p) => p.displayName, limit);
}

export function suggestPlaces(typed: string, places: Place[], limit = MODIFIER_SUGGESTIONS): Place[] {
  return bestMatches(typed.replace(/^~/, ''), places, (p) => [p.name], (p) => p.name, limit);
}

export interface DaySuggestion {
  // What picking it writes after the colon.
  value: string;
  label: string;
  // Today's and yesterday's date, beside the word.
  detail?: string;
}

// One formatter for every row ("Wed, Nov 18"); building one per call is slow.
const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// isoDay writes a day as on: reads it, in the reader's own calendar.
export function isoDay(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

// suggestDays offers days for on:, before: and after:: today, yesterday and
// the days before, matched by what was typed (a word, a weekday, a date's
// start); a whole date typed is offered as itself.
export function suggestDays(typed: string, now = new Date(), count = 7): DaySuggestion[] {
  const today = resolveDay('today', now)!;
  const days: DaySuggestion[] = [
    { value: 'today', label: 'Today', detail: DAY_FORMAT.format(today) },
    { value: 'yesterday', label: 'Yesterday', detail: DAY_FORMAT.format(addDays(today, -1)) },
  ];
  for (let i = 2; i < count; i++) {
    const day = addDays(today, -i);
    days.push({ value: isoDay(day), label: DAY_FORMAT.format(day) });
  }
  const t = foldName(typed);
  if (!t) return days;
  const matches = days.filter((d) => d.value.startsWith(t) || foldName(d.label).startsWith(t));
  const exact = resolveDay(typed, now);
  if (exact && !matches.some((d) => d.value === isoDay(exact) || resolveDay(d.value, now)?.getTime() === exact.getTime())) {
    matches.unshift({ value: isoDay(exact), label: DAY_FORMAT.format(exact) });
  }
  return matches;
}
