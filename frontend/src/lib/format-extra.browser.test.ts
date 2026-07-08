import { describe, expect, it } from 'vitest';
import { firstName, formatRelative, formatLongDate } from './format';

// Browser-gate coverage for the relative-time + firstName branches that the
// jsdom format test exercises (excluded from the jsdom gate).

describe('format helpers (browser)', () => {
  it('firstName returns an empty string for blank input', () => {
    expect(firstName('   ')).toBe('');
  });

  it('firstName returns the leading token', () => {
    expect(firstName('Alice Wonderland')).toBe('Alice');
  });

  it('formatRelative renders minutes / days / years with singular + plural', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(formatRelative(new Date('2026-06-15T11:30:00Z'), now)).toMatch(/30 minutes ago/);
    expect(formatRelative(new Date('2026-06-15T11:59:00Z'), now)).toMatch(/1 minute ago/);
    expect(formatRelative(new Date('2026-06-10T12:00:00Z'), now)).toMatch(/5 days ago/);
    expect(formatRelative(new Date('2026-06-14T12:00:00Z'), now)).toMatch(/1 day ago/);
    expect(formatRelative(new Date('2026-03-15T12:00:00Z'), now)).toMatch(/3 months ago/);
    expect(formatRelative(new Date('2026-05-11T12:00:00Z'), now)).toMatch(/1 month ago/);
    expect(formatRelative(new Date('2023-06-15T12:00:00Z'), now)).toMatch(/3 years ago/);
    expect(formatRelative(new Date('2025-06-15T12:00:00Z'), now)).toMatch(/1 year ago/);
  });

  it('formatLongDate accepts a Date instance directly', () => {
    const out = formatLongDate(new Date('2026-06-01T00:00:00Z'));
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('formatLongDate also accepts an ISO string', () => {
    expect(typeof formatLongDate('2026-06-01T00:00:00Z')).toBe('string');
  });
});
