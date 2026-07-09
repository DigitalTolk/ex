import { describe, expect, it } from 'vitest';
import {
  slugify,
  getInitials,
  extractURLs,
  firstName,
  firstNamesOnly,
  formatBytes,
  bytesToMib,
  mibToBytes,
  ordinalSuffix,
  formatLongDate,
  formatLongDateTime,
  formatRelative,
  formatDayHeading,
  dayKey,
} from './format';

// These are pure-string utilities — running them in the browser test
// runner ensures Intl / Date behaviour matches what users actually see.

describe('format — slugify / getInitials / firstName', () => {
  it('slugify lowercases, strips non-alnum, trims hyphens', () => {
    expect(slugify('General Chat!')).toBe('general-chat');
    expect(slugify('  weird---input!!!')).toBe('weird-input');
    expect(slugify('--leading-trailing--')).toBe('leading-trailing');
  });

  it('getInitials picks the first letter of the first two tokens', () => {
    expect(getInitials('Alice')).toBe('A');
    expect(getInitials('Alice Smith')).toBe('AS');
    expect(getInitials('alice von smith')).toBe('AV');
  });

  it('firstName trims leading whitespace and returns the first token', () => {
    expect(firstName('Alice Smith')).toBe('Alice');
    expect(firstName('   alice   smith ')).toBe('alice');
    expect(firstName('')).toBe('');
  });

  it('firstNamesOnly collapses each comma-separated full name', () => {
    expect(firstNamesOnly('Alice Smith, Bob Jones')).toBe('Alice, Bob');
    expect(firstNamesOnly('Project Team')).toBe('Project Team');
    expect(firstNamesOnly(undefined)).toBe('');
  });
});

describe('format — extractURLs', () => {
  it('returns http(s) URLs in plain text, stripping trailing punctuation', () => {
    expect(extractURLs('see https://example.org/page.')).toEqual(['https://example.org/page']);
    expect(extractURLs('https://a.io, https://b.io)')).toEqual(['https://a.io', 'https://b.io']);
  });

  it('skips URLs inside fenced code blocks and inline code spans', () => {
    expect(extractURLs('text ```\nhttps://hidden.io\n``` after')).toEqual([]);
    expect(extractURLs('inline `https://hidden.io` text https://shown.io')).toEqual(['https://shown.io']);
  });

  it('breaks out of an unterminated fence cleanly', () => {
    expect(extractURLs('```\nhttps://hidden.io')).toEqual([]);
  });

  it('returns an empty array for an empty body (the !body guard)', () => {
    expect(extractURLs('')).toEqual([]);
  });

  it('breaks out of an unterminated inline code span cleanly', () => {
    // Opening backtick with no closing one → the inline-code `if (end === -1)
    // break` arm runs; nothing after the backtick is scanned.
    expect(extractURLs('see `https://hidden.io')).toEqual([]);
  });
});

describe('format — date helpers accept string / number inputs', () => {
  it('formatRelative, formatDayHeading and dayKey parse ISO string inputs', () => {
    // All three use `input instanceof Date ? input : new Date(input)`; passing
    // an ISO string drives the `new Date(input)` side of each.
    const now = new Date(2026, 5, 15, 12, 0, 0);
    expect(formatRelative('2026-06-15T11:30:00', now)).toMatch(/30 minutes ago/);
    expect(formatDayHeading('2026-06-15T08:00:00', now)).toBe('Today');
    expect(dayKey('2026-03-07T09:00:00')).toBe('2026-03-07');
  });

  it('formatLongDate and formatLongDateTime accept a numeric timestamp', () => {
    const ts = new Date(2026, 7, 3, 18, 33, 1).getTime();
    expect(formatLongDate(ts)).toMatch(/August 3rd, 2026/);
    expect(formatLongDateTime(ts)).toBe('Aug 3rd at 18:33:01');
  });
});

describe('format — byte helpers', () => {
  it('formatBytes returns B / KB / MB at the right thresholds', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('bytesToMib rounds and mibToBytes floors for the inverse', () => {
    expect(bytesToMib(2 * 1024 * 1024)).toBe(2);
    expect(mibToBytes(2)).toBe(2 * 1024 * 1024);
  });
});

describe('format — ordinal and dates', () => {
  it('ordinalSuffix handles the 11/12/13 exceptions and the standard 1/2/3/4-suffixes', () => {
    expect(ordinalSuffix(1)).toBe('st');
    expect(ordinalSuffix(2)).toBe('nd');
    expect(ordinalSuffix(3)).toBe('rd');
    expect(ordinalSuffix(4)).toBe('th');
    expect(ordinalSuffix(11)).toBe('th');
    expect(ordinalSuffix(12)).toBe('th');
    expect(ordinalSuffix(13)).toBe('th');
    expect(ordinalSuffix(21)).toBe('st');
    expect(ordinalSuffix(112)).toBe('th');
  });

  it('formatLongDate renders "Month Nth, YYYY"', () => {
    expect(formatLongDate('2026-08-03T12:00:00Z')).toMatch(/August 3rd, 2026/);
  });

  it('formatLongDateTime renders "Mon Nth at HH:MM:SS"', () => {
    const out = formatLongDateTime(new Date(2026, 2, 26, 18, 33, 1));
    expect(out).toBe('Mar 26th at 18:33:01');
  });

  it('formatRelative covers every threshold branch', () => {
    const now = new Date(2026, 0, 1, 12, 0, 0);
    expect(formatRelative(new Date(now.getTime() - 10 * 1000), now)).toBe('just now');
    expect(formatRelative(new Date(now.getTime() - 5 * 60 * 1000), now)).toBe('5 minutes ago');
    expect(formatRelative(new Date(now.getTime() - 60 * 60 * 1000), now)).toBe('1 hour ago');
    expect(formatRelative(new Date(now.getTime() - 3 * 60 * 60 * 1000), now)).toBe('3 hours ago');
    expect(formatRelative(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000), now)).toBe('2 days ago');
    expect(formatRelative(new Date(now.getTime() - 2 * 30 * 24 * 60 * 60 * 1000), now)).toBe('2 months ago');
    expect(formatRelative(new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000), now)).toBe('2 years ago');
  });

  it('formatDayHeading distinguishes today / yesterday / older / cross-year', () => {
    const now = new Date(2026, 2, 26, 12, 0, 0);
    expect(formatDayHeading(now, now)).toBe('Today');
    expect(formatDayHeading(new Date(2026, 2, 25, 12, 0, 0), now)).toBe('Yesterday');
    expect(formatDayHeading(new Date(2026, 0, 1, 12, 0, 0), now)).toBe('Jan 1st');
    expect(formatDayHeading(new Date(2025, 11, 31, 12, 0, 0), now)).toBe('Dec 31st, 2025');
  });

  it('dayKey returns YYYY-MM-DD in local time', () => {
    const d = new Date(2026, 2, 7, 12, 0, 0);
    expect(dayKey(d)).toBe('2026-03-07');
  });
});
