import { describe, it, expect } from 'vitest';
import { normalizeEmojiInBody, unicodeToShortcode } from '@/lib/emoji-shortcodes';

describe('unicodeToShortcode', () => {
  it('returns the matching :name: for known emojis', () => {
    expect(unicodeToShortcode('👍')).toBe(':thumbsup:');
    expect(unicodeToShortcode('❤️')).toBe(':heart:');
  });

  it('passes unknown sequences through unchanged', () => {
    expect(unicodeToShortcode('🦄')).toBe('🦄');
  });
});

describe('normalizeEmojiInBody', () => {
  it('rewrites known unicode emoji to :shortcode:', () => {
    expect(normalizeEmojiInBody('hello 👍 world')).toBe('hello :thumbsup: world');
    expect(normalizeEmojiInBody('🎉 launch! 🎉')).toMatch(/:[a-z]+: launch! :[a-z]+:/);
  });

  it('leaves unknown emoji alone', () => {
    expect(normalizeEmojiInBody('mythical 🦄 friend')).toBe('mythical 🦄 friend');
  });

  it('preserves text inside fenced code blocks', () => {
    // The regression we want to lock in: `console.log("🎉")` must stay
    // verbatim — devs paste real code and the wire shouldn't rewrite it.
    const input = 'see this:\n```\nconsole.log("🎉")\n```\nyay 🎉';
    const out = normalizeEmojiInBody(input);
    expect(out).toContain('console.log("🎉")');
    expect(out).toMatch(/yay :[a-z]+:$/);
  });

  it('preserves text inside inline code spans', () => {
    const input = 'use `console.log("🎉")` to celebrate 🎉';
    const out = normalizeEmojiInBody(input);
    expect(out).toContain('`console.log("🎉")`');
    expect(out).toMatch(/celebrate :[a-z]+:$/);
  });

  it('handles multi-codepoint sequences (skin-tone variants) correctly', () => {
    // The regex sorts longest-first so the skin-toned variant wins
    // over the plain thumbsup.
    expect(normalizeEmojiInBody('great 👍🏽 work')).toMatch(/great :[a-z_]+: work/);
  });

  it('returns the input unchanged when there are no emojis', () => {
    expect(normalizeEmojiInBody('plain text only')).toBe('plain text only');
  });
});
