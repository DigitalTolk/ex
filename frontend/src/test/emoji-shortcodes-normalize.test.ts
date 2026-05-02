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
    expect(unicodeToShortcode('❤️')).toBe(':heart:');
    expect(unicodeToShortcode('😆')).toBe(':laughing:');
    expect(unicodeToShortcode('🎉')).toBe(':tada:');
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

  it('uses common canonical names for high-frequency chat emojis', () => {
    expect(unicodeToShortcode('😄')).toBe(':smile:');
    expect(unicodeToShortcode('😆')).toBe(':laughing:');
    expect(unicodeToShortcode('😂')).toBe(':joy:');
    expect(unicodeToShortcode('😍')).toBe(':heart_eyes:');
    expect(unicodeToShortcode('❤️')).toBe(':heart:');
    expect(unicodeToShortcode('💯')).toBe(':100:');
    expect(unicodeToShortcode('👋')).toBe(':wave:');
    expect(unicodeToShortcode('👏')).toBe(':clap:');
    expect(unicodeToShortcode('🙏')).toBe(':pray:');
    expect(unicodeToShortcode('🎉')).toBe(':tada:');
  });
});

describe('normalizeEmojiInBody', () => {
  it('rewrites known unicode emoji to :shortcode:', () => {
    expect(normalizeEmojiInBody('hello 👍 world')).toBe('hello :thumbsup: world');
    expect(normalizeEmojiInBody('🎉 launch! 🎉')).toBe(':tada: launch! :tada:');
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
    expect(out).toMatch(/yay :tada:$/);
  });

  it('preserves text inside inline code spans', () => {
    const input = 'use `console.log("🎉")` to celebrate 🎉';
    const out = normalizeEmojiInBody(input);
    expect(out).toContain('`console.log("🎉")`');
    expect(out).toMatch(/celebrate :tada:$/);
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

  it('converts the supported common ASCII emoticons', () => {
    expect(normalizeEmojiInBody('hi :)')).toBe('hi :slightly_smile_face:');
    expect(normalizeEmojiInBody('sad :-(')).toBe('sad :slightly_frown_face:');
    expect(normalizeEmojiInBody('wink ;)')).toBe('wink :winking_face:');
    expect(normalizeEmojiInBody('big grin :D')).toBe('big grin :smile:');
    expect(normalizeEmojiInBody('silly :P')).toBe('silly :face_tongue:');
    expect(normalizeEmojiInBody('silly :p')).toBe('silly :face_tongue:');
    expect(normalizeEmojiInBody('that was funny xD')).toBe('that was funny :laughing:');
    expect(normalizeEmojiInBody('we love this <3 keep going')).toBe('we love this :heart: keep going');
  });

  it('does not convert unsupported or embedded ASCII emoticons', () => {
    expect(normalizeEmojiInBody('path/to/file')).toBe('path/to/file');
    expect(normalizeEmojiInBody('abc:)')).toBe('abc:)');
    expect(normalizeEmojiInBody('indexD')).toBe('indexD');
  });
});
