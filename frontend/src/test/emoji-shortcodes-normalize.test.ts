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

  it('converts standalone ASCII emoticons to their :shortcode: form', () => {
    expect(normalizeEmojiInBody('hi :)')).toBe('hi :smile:');
    expect(normalizeEmojiInBody(';) cool')).toBe(':wink: cool');
    expect(normalizeEmojiInBody('we love this <3 keep going')).toBe(
      'we love this :heart: keep going',
    );
    expect(normalizeEmojiInBody('that was funny xD')).toBe('that was funny :laughing:');
    expect(normalizeEmojiInBody(":D so happy")).toBe(':smiley: so happy');
    expect(normalizeEmojiInBody('whoops :-(.')).toBe('whoops :disappointed:.');
  });

  it('does NOT convert emoticon-like sequences embedded in non-whitespace context', () => {
    // The colon at the end of a URL must not be rewritten.
    expect(normalizeEmojiInBody('see http://example.com:)')).toBe('see http://example.com:)');
    // Adjacent to a word — not a real emoticon.
    expect(normalizeEmojiInBody('list:price:)')).toBe('list:price:)');
  });

  it('does NOT touch emoticons inside code spans', () => {
    expect(normalizeEmojiInBody('use `if (a) :)` carefully')).toBe(
      'use `if (a) :)` carefully',
    );
  });

  it('handles emoticon followed by punctuation', () => {
    expect(normalizeEmojiInBody('great :), thanks!')).toBe('great :smile:, thanks!');
    expect(normalizeEmojiInBody('done :)!')).toBe('done :smile:!');
  });

  it('prefers the longer emoticon variant when both could match', () => {
    // The trailing `)` of `:-)` would also match `:)` — sort by length
    // ensures `:-)` wins.
    expect(normalizeEmojiInBody('hi :-)')).toBe('hi :smile:');
  });
});
