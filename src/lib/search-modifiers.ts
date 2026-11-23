// Search modifiers, as in Mattermost: "datadog from:Günter in:~ops
// after:2026-11-01" searches for "datadog" in messages Günter wrote in ~ops
// since November 2nd. A value with spaces goes in quotes (from:"Günter
// Weber"); from: takes a name, a first name, an email or its part before the
// @, with or without a leading @; in: takes a channel (with or without ~) or a
// DM's name; on:, before: and after: take a day (2026-11-20, today,
// yesterday). They become the search's from/in filters and a date range.

export type SearchModifier = 'from' | 'in' | 'on' | 'before' | 'after';
export type DateModifier = 'on' | 'before' | 'after';

export interface ParsedSearch {
  // What is left to search for once the modifiers are taken out.
  text: string;
  from?: string;
  in?: string;
  on?: string;
  before?: string;
  after?: string;
}

const MODIFIER = /(^|\s)(from|in|on|before|after):(?:"([^"]*)"|(\S+))/gi;

export function parseSearchModifiers(q: string): ParsedSearch {
  const out: ParsedSearch = { text: '' };
  const text = q.replace(MODIFIER, (_m, lead: string, key: string, quoted: string | undefined, bare: string | undefined) => {
    // The pattern captures one or the other, never neither.
    const value = String(quoted ?? bare).trim();
    if (value) out[key.toLowerCase() as SearchModifier] = value;
    return lead;
  });
  out.text = text.replace(/\s+/g, ' ').trim();
  return out;
}

// withoutModifier drops one kind of modifier from a query, keeping the rest
// as typed: what removing that filter's chip does.
export function withoutModifier(q: string, key: SearchModifier): string {
  return q
    .replace(MODIFIER, (m, lead: string, k: string) => (k.toLowerCase() === key ? lead : m))
    .replace(/\s+/g, ' ')
    .trim();
}

// Names compare without case or accents, so "from:gunter" finds Günter.
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
}

interface Person {
  id: string;
  displayName: string;
  email?: string;
}

// resolveFromPerson picks who from:<value> means: an exact email, its part
// before the @, the full name, then a first name, then the start of a name.
// The first that matches anyone wins; among several, the first by name.
export function resolveFromPerson<P extends Person>(value: string, people: P[]): P | undefined {
  const v = foldName(value.replace(/^@/, ''));
  if (!v) return undefined;
  const byName = [...people].sort((a, b) => a.displayName.localeCompare(b.displayName));
  const tiers: ((p: P) => boolean)[] = [
    (p) => foldName(p.email ?? '') === v,
    (p) => foldName((p.email ?? '').split('@')[0]) === v,
    (p) => foldName(p.displayName) === v,
    (p) => foldName(p.displayName).split(/\s+/)[0] === v,
    (p) => foldName(p.displayName).startsWith(v),
  ];
  for (const matches of tiers) {
    const hit = byName.find(matches);
    if (hit) return hit;
  }
  return undefined;
}

interface Place {
  id: string;
  name: string;
}

// resolveInPlace picks the channel or DM in:<value> means, by its exact name
// (a channel's with or without ~), then by the start of one.
export function resolveInPlace(value: string, places: Place[]): Place | undefined {
  const v = foldName(value.replace(/^~/, ''));
  if (!v) return undefined;
  return places.find((p) => foldName(p.name) === v) ?? places.find((p) => foldName(p.name).startsWith(v));
}

// A day, as a date modifier names it: 2026-11-20, today or yesterday. The
// day starts at midnight in the reader's timezone. Anything else, or a date
// that doesn't exist (2026-02-30), is no day.
export function resolveDay(value: string, now = new Date()): Date | undefined {
  const v = value.trim().toLowerCase();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (v === 'today') return today;
  if (v === 'yesterday') return addDays(today, -1);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const day = new Date(y, mo, d);
  return day.getFullYear() === y && day.getMonth() === mo && day.getDate() === d ? day : undefined;
}

export function addDays(day: Date, n: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
}

export interface DateRange {
  // From this instant on, and before that one.
  after?: Date;
  before?: Date;
  // The first date modifier that names no day, as typed.
  invalid?: string;
}

// dateRange is the span the date modifiers leave, as Mattermost reads them:
// on: that day; after: from the next day on; before: up to that day.
// Several narrow each other.
export function dateRange(parsed: Pick<ParsedSearch, DateModifier>, now = new Date()): DateRange {
  const out: DateRange = {};
  const narrow = (after?: Date, before?: Date) => {
    if (after && (!out.after || after > out.after)) out.after = after;
    if (before && (!out.before || before < out.before)) out.before = before;
  };
  for (const key of ['on', 'after', 'before'] as const) {
    const value = parsed[key];
    if (value === undefined) continue;
    const day = resolveDay(value, now);
    if (!day) {
      out.invalid ??= `${key}:${value}`;
      continue;
    }
    if (key === 'on') narrow(day, addDays(day, 1));
    else if (key === 'after') narrow(addDays(day, 1), undefined);
    else narrow(undefined, day);
  }
  return out;
}

// unmatchedNote says why a modifier found nothing: a day that isn't one, or
// a name that matches no one.
export function unmatchedNote(unmatched: string): string {
  return /^(on|before|after):/.test(unmatched)
    ? `“${unmatched}” isn't a day. Use a date like 2026-11-20, today or yesterday.`
    : `Nothing matches “${unmatched}”.`;
}
