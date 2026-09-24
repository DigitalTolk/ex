import { describe, it, expect } from 'vitest';
import {
  ERROR_SUMMARY_MAX,
  connectorInitials,
  connectorTint,
  summarizeError,
} from '@/lib/connector-ui';

describe('connectorInitials', () => {
  it('takes the first letters of the first two words', () => {
    expect(connectorInitials('Growth Hub')).toBe('GH');
    expect(connectorInitials('  Meeting   Mind  extra')).toBe('MM');
  });

  it('treats camel-case as a word break', () => {
    expect(connectorInitials('CliffHub')).toBe('CH');
    expect(connectorInitials('GitLab')).toBe('GL');
    expect(connectorInitials('MeetingMind')).toBe('MM');
    expect(connectorInitials('GrowthHub CRM')).toBe('GH');
  });

  it('takes the first two letters of a single plain word, and survives an empty title', () => {
    expect(connectorInitials('Metabase')).toBe('ME');
    expect(connectorInitials('x')).toBe('X');
    expect(connectorInitials('')).toBe('');
    expect(connectorInitials('   ')).toBe('');
  });
});

describe('connectorTint', () => {
  it('is deterministic per slug and always a palette class', () => {
    const a = connectorTint('cliffhub');
    expect(connectorTint('cliffhub')).toBe(a);
    expect(a).toMatch(/^text-[a-z]+-600 dark:text-[a-z]+-400$/);
    expect(connectorTint('')).toMatch(/^text-[a-z]+-600 dark:text-[a-z]+-400$/);
  });

  it('spreads different slugs across the palette', () => {
    const tints = new Set(['cliffhub', 'gitlab', 'growthhub', 'metabase', 'sourcebot', 'meetingmind'].map(connectorTint));
    expect(tints.size).toBeGreaterThan(1);
  });
});

describe('summarizeError', () => {
  it('collapses a gateway HTML error page to its title, keeping the raw page as details', () => {
    const page = '<!DOCTYPE html><html><head>\n<title>digitaltolk.net | 502: Bad gateway</title></head><body><h1>Bad gateway</h1></body></html>';
    const out = summarizeError(page);
    expect(out.summary).toBe('digitaltolk.net | 502: Bad gateway');
    expect(out.details).toBe(page);
  });

  it('strips markup when there is no title', () => {
    const out = summarizeError('<p>Service   <b>unavailable</b></p>');
    expect(out.summary).toBe('Service unavailable');
    expect(out.details).toBe('<p>Service   <b>unavailable</b></p>');
  });

  it('clips long plain text and offers the full text as details', () => {
    const long = 'x'.repeat(ERROR_SUMMARY_MAX + 40);
    const out = summarizeError(long);
    expect(out.summary).toHaveLength(ERROR_SUMMARY_MAX);
    expect(out.summary.endsWith('…')).toBe(true);
    expect(out.details).toBe(long);
  });

  it('passes a short plain message through untouched, with no details', () => {
    expect(summarizeError('token expired')).toEqual({ summary: 'token expired' });
    expect(summarizeError('  token expired  ')).toEqual({ summary: 'token expired' });
  });

  it('falls back to a generic line when the page has an empty title', () => {
    const out = summarizeError('<title></title>');
    expect(out.summary).toBe('Request failed');
    expect(out.details).toBe('<title></title>');
  });
});
