import { describe, it, expect } from 'vitest';
import {
  COMMON_EMOJI_SHORTCODES,
  EMOJI_SKIN_TONES,
  applyEmojiSkinTone,
  normalizeEmojiInBody,
  shortcodeToUnicode,
  shortcodeWithSkinTone,
  supportsEmojiSkinTone,
  unicodeToShortcode,
} from '@/lib/emoji-shortcodes';

describe('unicodeToShortcode', () => {
  it('returns the matching :name: for known emojis', () => {
    expect(unicodeToShortcode('👍')).toBe(':thumbsup:');
    expect(unicodeToShortcode('❤️')).toBe(':red_heart:');
    expect(unicodeToShortcode('😆')).toBe(':grin_squint_face:');
  });

  it('passes unknown sequences through unchanged', () => {
    // Private-use codepoint — never going to land in the Unicode emoji
    // table, so this is the safe "definitely unknown" sentinel now
    // that the picker covers the full CLDR set.
    expect(unicodeToShortcode('')).toBe('');
  });

  it('resolves generated skin-tone shortcodes for supported emojis', () => {
    expect(shortcodeWithSkinTone('thumbsup', '👍', 'medium')).toBe(':thumbsup::skin-tone-3:');
    expect(shortcodeToUnicode(':skin-tone-3:')).toBe('🏽');
    expect(shortcodeToUnicode(':thumbsup_skin-tone-3:')).toBe(':thumbsup_skin-tone-3:');
    expect(shortcodeToUnicode(':thumbsup_medium_skin_tone:')).toBe(':thumbsup_medium_skin_tone:');
    expect(applyEmojiSkinTone('🚀', 'medium')).toBe('🚀');
  });

  it('keeps all standard emoji shortcodes within the 32 character limit', () => {
    for (const emoji of COMMON_EMOJI_SHORTCODES) {
      expect(emoji.name.length, emoji.name).toBeLessThanOrEqual(32);
      if (!supportsEmojiSkinTone(emoji.unicode)) continue;
      for (const tone of EMOJI_SKIN_TONES) {
        if (!tone.value) continue;
        const shortcode = shortcodeWithSkinTone(emoji.name, emoji.unicode, tone.value);
        const [base, suffix] = shortcode.slice(1, -1).split('::');
        expect(base.length, shortcode).toBeLessThanOrEqual(32);
        expect(suffix.length, shortcode).toBeLessThanOrEqual(32);
      }
    }
  });

  it('applies skin tone before variation selectors for modifier-base emojis', () => {
    expect(shortcodeWithSkinTone('hand', '🖐️', 'medium')).toBe(':hand::skin-tone-3:');
    expect(applyEmojiSkinTone('🖐️', 'medium')).toBe('🖐🏽');
  });

  it('does not apply skin tones to ZWJ family emoji sequences', () => {
    expect(supportsEmojiSkinTone('👨‍👩‍👦')).toBe(false);
    expect(shortcodeWithSkinTone('family_man_woman_boy', '👨‍👩‍👦', 'medium')).toBe(':family_man_woman_boy:');
  });

  it('keeps raised_hands as the canonical shortcode for 🙌', () => {
    expect(COMMON_EMOJI_SHORTCODES.some((emoji) => emoji.name === 'raised_hands')).toBe(true);
    expect(COMMON_EMOJI_SHORTCODES.some((emoji) => emoji.name === 'raising_hands')).toBe(false);
    expect(unicodeToShortcode('🙌')).toBe(':raised_hands:');
  });
});

describe('normalizeEmojiInBody', () => {
  it('rewrites known unicode emoji to :shortcode:', () => {
    expect(normalizeEmojiInBody('hello 👍 world')).toBe('hello :thumbsup: world');
    expect(normalizeEmojiInBody('🎉 launch! 🎉')).toBe(':party_popper: launch! :party_popper:');
  });

  it('leaves unknown emoji-shaped codepoints alone', () => {
    // Private-use codepoint — won't ever be in the Unicode emoji
    // table, so the normalizer leaves it verbatim.
    expect(normalizeEmojiInBody('mythical  friend')).toBe('mythical  friend');
  });

  it('preserves text inside fenced code blocks', () => {
    // The regression we want to lock in: `console.log("🎉")` must stay
    // verbatim — devs paste real code and the wire shouldn't rewrite it.
    const input = 'see this:\n```\nconsole.log("🎉")\n```\nyay 🎉';
    const out = normalizeEmojiInBody(input);
    expect(out).toContain('console.log("🎉")');
    expect(out).toMatch(/yay :party_popper:$/);
  });

  it('preserves text inside inline code spans', () => {
    const input = 'use `console.log("🎉")` to celebrate 🎉';
    const out = normalizeEmojiInBody(input);
    expect(out).toContain('`console.log("🎉")`');
    expect(out).toMatch(/celebrate :party_popper:$/);
  });

  it('handles multi-codepoint sequences (skin-tone variants) correctly', () => {
    // The regex sorts longest-first so the skin-toned variant wins
    // over the plain thumbsup.
    expect(normalizeEmojiInBody('great 👍🏽 work')).toBe('great :thumbsup::skin-tone-3: work');
    expect(normalizeEmojiInBody('hi 🖐🏽')).toBe('hi :hand::skin-tone-3:');
  });

  it('returns the input unchanged when there are no emojis', () => {
    expect(normalizeEmojiInBody('plain text only')).toBe('plain text only');
  });

  it('does NOT touch emoticons inside code spans', () => {
    expect(normalizeEmojiInBody('use `if (a) :)` carefully')).toBe(
      'use `if (a) :)` carefully',
    );
  });

  it('does not convert ASCII emoticons', () => {
    expect(normalizeEmojiInBody('hi :)')).toBe('hi :)');
    expect(normalizeEmojiInBody('that was funny xD')).toBe('that was funny xD');
    expect(normalizeEmojiInBody('we love this <3 keep going')).toBe('we love this <3 keep going');
  });
});
