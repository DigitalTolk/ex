import { describe, it, expect } from 'vitest';
import {
  MAX_CHANNEL_DESCRIPTION_LEN,
  MAX_CHANNEL_NAME_LEN,
  MAX_MESSAGE_BODY_CHARS,
  countCodepoints,
  validateChannelDescription,
  validateChannelName,
} from '@/lib/limits';

describe('countCodepoints', () => {
  it('counts ASCII as one per char', () => {
    expect(countCodepoints('hello')).toBe(5);
    expect(countCodepoints('')).toBe(0);
  });

  it('counts emoji and astral chars as one codepoint each (matching backend)', () => {
    // "🚀" is 1 codepoint, 2 UTF-16 code units. We must NOT use .length.
    expect(countCodepoints('🚀')).toBe(1);
    expect(countCodepoints('🚀🚀🚀')).toBe(3);
    // Combining sequences: "é" is 1 codepoint when written as U+00E9.
    expect(countCodepoints('é')).toBe(1);
  });

  it('matches the cap exactly so the UI can render N/MAX counters', () => {
    const at = 'a'.repeat(MAX_MESSAGE_BODY_CHARS);
    expect(countCodepoints(at)).toBe(MAX_MESSAGE_BODY_CHARS);
  });
});

describe('validateChannelName', () => {
  it('accepts slug-style names', () => {
    for (const ok of ['general', 'team-1', 'a', 'feat-123', 'engineering']) {
      expect(validateChannelName(ok)).toBeNull();
    }
  });

  it('rejects spaces, casing, and special characters', () => {
    expect(validateChannelName('Has Space')?.kind).toBe('invalid');
    expect(validateChannelName('CamelCase')?.kind).toBe('invalid');
    expect(validateChannelName('hi!')?.kind).toBe('invalid');
    expect(validateChannelName('-leading')?.kind).toBe('invalid');
    expect(validateChannelName('trailing-')?.kind).toBe('invalid');
    expect(validateChannelName('double--hyphen')?.kind).toBe('invalid');
    expect(validateChannelName('emoji-🚀')?.kind).toBe('invalid');
  });

  it('rejects names over MAX_CHANNEL_NAME_LEN with the "too-long" kind', () => {
    const long = 'a'.repeat(MAX_CHANNEL_NAME_LEN + 1);
    expect(validateChannelName(long)?.kind).toBe('too-long');
  });

  it('returns null for empty input — required-field UX handles that', () => {
    expect(validateChannelName('')).toBeNull();
  });
});

describe('validateChannelDescription', () => {
  it('accepts descriptions at or below MAX_CHANNEL_DESCRIPTION_LEN', () => {
    expect(validateChannelDescription('')).toBeNull();
    expect(validateChannelDescription('a'.repeat(MAX_CHANNEL_DESCRIPTION_LEN))).toBeNull();
  });

  it('rejects descriptions above the cap', () => {
    expect(
      validateChannelDescription('a'.repeat(MAX_CHANNEL_DESCRIPTION_LEN + 1)),
    ).toMatch(/255/);
  });
});
