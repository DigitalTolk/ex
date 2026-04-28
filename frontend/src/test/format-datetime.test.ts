import { describe, it, expect } from 'vitest';
import { ordinalSuffix, formatLongDateTime, formatDayHeading, formatRelative, firstNamesOnly, extractURLs, dayKey } from '@/lib/format';

describe('ordinalSuffix', () => {
  it('handles 1, 2, 3, 4 correctly', () => {
    expect(ordinalSuffix(1)).toBe('st');
    expect(ordinalSuffix(2)).toBe('nd');
    expect(ordinalSuffix(3)).toBe('rd');
    expect(ordinalSuffix(4)).toBe('th');
  });

  it('handles the 11/12/13 exception block', () => {
    expect(ordinalSuffix(11)).toBe('th');
    expect(ordinalSuffix(12)).toBe('th');
    expect(ordinalSuffix(13)).toBe('th');
  });

  it('handles 21st, 22nd, 23rd at month-end', () => {
    expect(ordinalSuffix(21)).toBe('st');
    expect(ordinalSuffix(22)).toBe('nd');
    expect(ordinalSuffix(23)).toBe('rd');
    expect(ordinalSuffix(31)).toBe('st');
  });
});

describe('formatLongDateTime', () => {
  it('renders "Mar 26th at 18:33:01" for the example date', () => {
    const d = new Date(2026, 2, 26, 18, 33, 1);
    expect(formatLongDateTime(d)).toBe('Mar 26th at 18:33:01');
  });

  it('zero-pads single-digit hours/minutes/seconds', () => {
    const d = new Date(2026, 0, 1, 9, 5, 7);
    expect(formatLongDateTime(d)).toBe('Jan 1st at 09:05:07');
  });

  it('accepts ISO strings as well as Date instances', () => {
    const d = new Date(2026, 4, 22, 14, 0, 0);
    expect(formatLongDateTime(d.toISOString())).toBe(formatLongDateTime(d));
  });
});

describe('formatDayHeading', () => {
  it('returns "Today" when the timestamp is in the same calendar day', () => {
    const now = new Date(2026, 3, 26, 14, 0, 0);
    const sameDay = new Date(2026, 3, 26, 8, 30, 0);
    expect(formatDayHeading(sameDay, now)).toBe('Today');
  });

  it('returns "Yesterday" for the day before', () => {
    const now = new Date(2026, 3, 26, 14, 0, 0);
    const y = new Date(2026, 3, 25, 23, 59, 0);
    expect(formatDayHeading(y, now)).toBe('Yesterday');
  });

  it('returns month + day without year when in the same year', () => {
    const now = new Date(2026, 3, 26);
    expect(formatDayHeading(new Date(2026, 2, 11), now)).toBe('Mar 11th');
  });

  it('includes the year for older dates', () => {
    const now = new Date(2026, 3, 26);
    expect(formatDayHeading(new Date(2025, 11, 31), now)).toBe('Dec 31st, 2025');
  });
});

describe('formatRelative', () => {
  const now = new Date(2026, 3, 26, 14, 0, 0);

  it('returns "just now" for very recent timestamps', () => {
    expect(formatRelative(new Date(now.getTime() - 5_000), now)).toBe('just now');
  });

  it('returns minutes-ago for sub-hour gaps', () => {
    expect(formatRelative(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 minutes ago');
    expect(formatRelative(new Date(now.getTime() - 60_000), now)).toBe('1 minute ago');
  });

  it('returns hours-ago for sub-day gaps', () => {
    expect(formatRelative(new Date(now.getTime() - 2 * 3_600_000), now)).toBe('2 hours ago');
    expect(formatRelative(new Date(now.getTime() - 3_600_000), now)).toBe('1 hour ago');
  });

  it('returns days-ago for sub-month gaps', () => {
    expect(formatRelative(new Date(now.getTime() - 3 * 86_400_000), now)).toBe('3 days ago');
  });

  it('returns months-ago for sub-year gaps', () => {
    expect(formatRelative(new Date(now.getTime() - 90 * 86_400_000), now)).toBe('3 months ago');
  });

  it('returns years-ago for older timestamps', () => {
    expect(formatRelative(new Date(now.getTime() - 400 * 86_400_000), now)).toBe('1 year ago');
  });
});

describe('dayKey', () => {
  it('formats as YYYY-MM-DD with zero padding', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(dayKey(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('groups two timestamps on the same day to the same key', () => {
    const a = new Date(2026, 3, 26, 0, 0, 1);
    const b = new Date(2026, 3, 26, 23, 59, 59);
    expect(dayKey(a)).toBe(dayKey(b));
  });
});

describe('firstNamesOnly', () => {
  it('collapses each comma-separated entry to its first word', () => {
    expect(firstNamesOnly('Alice Smith, Bob Jones, Charlie Brown')).toBe('Alice, Bob, Charlie');
  });

  it('passes through single-word entries unchanged', () => {
    expect(firstNamesOnly('Alice, Bob')).toBe('Alice, Bob');
  });

  it('trims whitespace around commas', () => {
    expect(firstNamesOnly('Alice Smith ,  Bob Jones')).toBe('Alice, Bob');
  });

  it('returns empty string for empty input', () => {
    expect(firstNamesOnly('')).toBe('');
    expect(firstNamesOnly(undefined)).toBe('');
  });

  it('drops blank entries entirely', () => {
    expect(firstNamesOnly('Alice, , Bob Jones')).toBe('Alice, Bob');
  });

  it('leaves a single-token custom label alone (no comma → not a name list)', () => {
    expect(firstNamesOnly('Project Team')).toBe('Project Team');
  });
});

describe('extractURLs', () => {
  it('returns the URL when one is present in plain prose', () => {
    expect(extractURLs('see https://example.com for details')).toEqual(['https://example.com']);
  });

  it('returns multiple URLs in source order', () => {
    expect(
      extractURLs('first http://a.test then https://b.test/path'),
    ).toEqual(['http://a.test', 'https://b.test/path']);
  });

  it('strips trailing sentence punctuation', () => {
    expect(extractURLs('check https://example.com.')).toEqual(['https://example.com']);
    expect(extractURLs('great link (https://example.com)?')).toEqual(['https://example.com']);
  });

  it('skips URLs inside fenced code blocks', () => {
    const md = 'paste this\n```\ncurl https://hidden.test\n```\nand visit https://shown.test';
    expect(extractURLs(md)).toEqual(['https://shown.test']);
  });

  it('skips URLs inside inline code spans', () => {
    expect(
      extractURLs('use `curl https://hidden.test` then https://shown.test'),
    ).toEqual(['https://shown.test']);
  });

  it('returns an empty array when there are no URLs', () => {
    expect(extractURLs('plain text only')).toEqual([]);
  });
});
