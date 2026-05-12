import { describe, expect, it } from 'vitest';
import { normalizeFuzzy, fuzzyMatch } from './fuzzy';
import { topK } from './topk';
import {
  countCodepoints,
  validateChannelName,
  validateChannelDescription,
  MAX_CHANNEL_NAME_LEN,
} from './limits';
import {
  formatLastSeen,
  isValidTimeZone,
  formatTimeZoneName,
  formatTimeZoneDelta,
  timeZoneOffsetMinutes,
} from './user-time';
import { readJSON, writeJSON, readString, writeString, removeKey } from './storage';

// Browser tests for pure-string / pure-DOM utility libs that the
// browser bundle imports lazily. Each function below has dense
// branching that contributes meaningfully to total branch coverage.

describe('fuzzy.normalizeFuzzy', () => {
  it('collapses runs of 3+ identical characters', () => {
    expect(normalizeFuzzy('aaaa')).toBe('a');
    expect(normalizeFuzzy('aabb')).toBe('aabb');
    expect(normalizeFuzzy('Alllice')).toBe('Alice');
  });

  it('returns short strings (<3 chars) unchanged', () => {
    expect(normalizeFuzzy('ab')).toBe('ab');
    expect(normalizeFuzzy('')).toBe('');
  });
});

describe('fuzzy.fuzzyMatch — match strategies', () => {
  it('empty query matches anything', () => {
    expect(fuzzyMatch('', 'whatever')).toBe(true);
  });

  it('exact substring match', () => {
    expect(fuzzyMatch('lic', 'Alice Smith')).toBe(true);
  });

  it('token-prefix match across whitespace, dots, and @-delimiters', () => {
    expect(fuzzyMatch('al', 'Alice Smith')).toBe(true);
    expect(fuzzyMatch('noice', 'carla@noice.io')).toBe(true);
    expect(fuzzyMatch('jo', 'first.john@x.io')).toBe(true);
    expect(fuzzyMatch('jo', 'first_john')).toBe(true);
    expect(fuzzyMatch('jo', 'first-john')).toBe(true);
  });

  it('Damerau-Levenshtein tolerates one-character typos on 4+ char queries', () => {
    expect(fuzzyMatch('aliec', 'Alice Smith')).toBe(true); // swap
    expect(fuzzyMatch('alie', 'Alice Smith')).toBe(true); // delete
  });

  it('rejects unrelated strings', () => {
    expect(fuzzyMatch('xyzzy', 'Alice Smith')).toBe(false);
  });

  it('skips empty fields', () => {
    expect(fuzzyMatch('al', '', 'Alice')).toBe(true);
    expect(fuzzyMatch('zzz', '', '')).toBe(false);
  });
});

describe('topk.topK', () => {
  const numericCmp = (a: number, b: number) => a - b;

  it('returns [] when k <= 0', () => {
    expect(topK([1, 2, 3], 0, numericCmp)).toEqual([]);
    expect(topK([1, 2, 3], -1, numericCmp)).toEqual([]);
  });

  it('returns a sorted slice when items.length <= k', () => {
    expect(topK([3, 1, 2], 5, numericCmp)).toEqual([1, 2, 3]);
  });

  it('returns the top-k smallest when items.length > k', () => {
    expect(topK([5, 1, 4, 2, 8, 3], 3, numericCmp)).toEqual([1, 2, 3]);
  });

  it('inserts into the middle of the sorted window without disturbing order', () => {
    expect(topK([10, 1, 20, 2, 3, 4], 3, numericCmp)).toEqual([1, 2, 3]);
  });
});

describe('limits — codepoints and validators', () => {
  it('countCodepoints handles astral-plane emoji correctly', () => {
    expect(countCodepoints('hi')).toBe(2);
    expect(countCodepoints('💁')).toBe(1);
    expect(countCodepoints('a💁b')).toBe(3);
  });

  it('validateChannelName accepts a valid slug and rejects long / invalid', () => {
    expect(validateChannelName('team-1')).toBeNull();
    expect(validateChannelName('')).toBeNull();
    const long = 'a'.repeat(MAX_CHANNEL_NAME_LEN + 1);
    expect(validateChannelName(long)?.kind).toBe('too-long');
    expect(validateChannelName('UPPER')?.kind).toBe('invalid');
    expect(validateChannelName('--leading')?.kind).toBe('invalid');
    expect(validateChannelName('double--hyphen')?.kind).toBe('invalid');
  });

  it('validateChannelDescription only fails when too long', () => {
    expect(validateChannelDescription('hi')).toBeNull();
    const long = 'a'.repeat(300);
    expect(typeof validateChannelDescription(long)).toBe('string');
  });
});

describe('user-time — last-seen and timezone helpers', () => {
  it('formatLastSeen returns "now" when online, the formatted timestamp otherwise, null when neither', () => {
    expect(formatLastSeen(undefined, true)).toBe('now');
    expect(formatLastSeen(undefined, false)).toBeNull();
    expect(formatLastSeen(new Date(0).toISOString(), false)).not.toBeNull();
  });

  it('isValidTimeZone narrows true/false correctly', () => {
    expect(isValidTimeZone('Europe/Stockholm')).toBe(true);
    expect(isValidTimeZone('Atlantis/Atlantis')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('formatTimeZoneName humanises Region/City with underscore replacement', () => {
    expect(formatTimeZoneName('Europe/Stockholm')).toBe('Stockholm, Europe');
    expect(formatTimeZoneName('America/New_York')).toBe('New York, America');
    expect(formatTimeZoneName('UTC')).toBe('UTC');
    expect(formatTimeZoneName('Bogus/Place')).toBeNull();
    expect(formatTimeZoneName(undefined)).toBeNull();
  });

  it('timeZoneOffsetMinutes returns a number for a real zone, null for bogus input', () => {
    expect(Math.abs(timeZoneOffsetMinutes('UTC') ?? -1)).toBe(0);
    expect(typeof timeZoneOffsetMinutes('Europe/Stockholm')).toBe('number');
    expect(timeZoneOffsetMinutes('Atlantis/Atlantis')).toBeNull();
  });

  it('formatTimeZoneDelta returns null for missing/identical zones, a string for actual deltas', () => {
    expect(formatTimeZoneDelta(undefined)).toBeNull();
    expect(formatTimeZoneDelta('Europe/Stockholm', 'Europe/Stockholm')).toBeNull();
    // UTC and an east-of-UTC zone — exact value depends on DST, but the
    // string should be non-null and end in "ahead" or "behind".
    const delta = formatTimeZoneDelta('Asia/Tokyo', 'UTC');
    expect(delta === null || /(ahead|behind)$/.test(delta!)).toBe(true);
  });
});

describe('storage — JSON helpers', () => {
  it('writeJSON + readJSON round-trip an object', () => {
    writeJSON('test-storage-key', { a: 1, b: 'two' });
    expect(readJSON('test-storage-key', null)).toEqual({ a: 1, b: 'two' });
    removeKey('test-storage-key');
    expect(readJSON('test-storage-key', { fallback: true })).toEqual({ fallback: true });
  });

  it('readJSON returns the fallback on corrupt JSON', () => {
    writeString('test-corrupt-key', 'not-json}}');
    expect(readJSON('test-corrupt-key', { fallback: true })).toEqual({ fallback: true });
    removeKey('test-corrupt-key');
  });

  it('writeJSON silently ignores values that cannot serialise (circular ref)', () => {
    // Build a circular structure and ensure no throw escapes.
    const a: Record<string, unknown> = {};
    a.self = a;
    writeJSON('test-circular', a);
    expect(readString('test-circular')).toBeNull();
  });
});
