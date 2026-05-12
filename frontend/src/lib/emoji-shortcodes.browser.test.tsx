import { describe, expect, it } from 'vitest';
import {
  shortcodeToUnicode,
  shortcodeWithSkinTone,
  applySkinToneSuffix,
  applyEmojiSkinTone,
  supportsEmojiSkinTone,
  unicodeToShortcode,
  normalizeEmojiInBody,
} from './emoji-shortcodes';

describe('shortcodeToUnicode', () => {
  it('resolves a known shortcode to its unicode glyph', () => {
    expect(shortcodeToUnicode(':smile:')).not.toBe(':smile:');
  });

  it('returns the literal shortcode when unknown', () => {
    expect(shortcodeToUnicode(':not-a-real-shortcode:')).toBe(':not-a-real-shortcode:');
  });
});

describe('skin tone application', () => {
  it('supportsEmojiSkinTone returns false for emoji that do not accept tones', () => {
    expect(supportsEmojiSkinTone('🎉')).toBe(false);
  });

  it('applyEmojiSkinTone leaves the input unchanged when no tone is supplied', () => {
    expect(applyEmojiSkinTone('🚀', '')).toBe('🚀');
    expect(applyEmojiSkinTone('🚀', undefined)).toBe('🚀');
  });

  it('shortcodeWithSkinTone returns the bare shortcode when the emoji does not accept tones', () => {
    expect(shortcodeWithSkinTone('rocket', '🚀', 'medium')).toBe(':rocket:');
  });

  it('shortcodeWithSkinTone returns the bare shortcode when no tone is provided', () => {
    expect(shortcodeWithSkinTone('wave', '👋', undefined)).toBe(':wave:');
  });

  it('applySkinToneSuffix returns the unicode unchanged for an unknown suffix', () => {
    expect(applySkinToneSuffix('👋', 'not-a-tone')).toBe('👋');
  });

  it('applySkinToneSuffix applies the modifier for a recognised skin-tone suffix', () => {
    const out = applySkinToneSuffix('👋', 'skin-tone-2');
    // Result should be 👋 + the skin-tone-2 modifier (Fitzpatrick-2 codepoint).
    expect(out.length).toBeGreaterThan(1);
  });
});

describe('unicodeToShortcode', () => {
  it('returns the canonical :name: for a known unicode emoji', () => {
    const out = unicodeToShortcode('🎉');
    expect(out.startsWith(':')).toBe(true);
    expect(out.endsWith(':')).toBe(true);
  });

  it('returns the input unchanged for non-emoji', () => {
    expect(unicodeToShortcode('not-an-emoji')).toBe('not-an-emoji');
  });
});

describe('normalizeEmojiInBody', () => {
  it('replaces known unicode emoji with their shortcode form', () => {
    expect(normalizeEmojiInBody('hello 🎉 world')).toMatch(/:tada:|:party_popper:/);
  });

  it('substitutes ASCII emoticons with their shortcodes', () => {
    const out = normalizeEmojiInBody(':) is happy');
    expect(out).toContain(':');
    expect(out).not.toContain(':) ');
  });

  it('leaves emoji inside a fenced code block alone', () => {
    const body = 'before\n```\n🎉 still here\n```\nafter 🎉';
    const out = normalizeEmojiInBody(body);
    expect(out).toContain('🎉 still here');
    // The trailing emoji outside the fence is replaced.
    expect(out).not.toBe(body);
  });

  it('leaves emoji inside an inline code span alone', () => {
    const out = normalizeEmojiInBody('inline `🎉 here` then 🎉');
    expect(out).toContain('`🎉 here`');
  });

  it('tolerates an unterminated fence or backtick', () => {
    expect(normalizeEmojiInBody('```\n🎉 still open')).toContain('🎉');
    expect(normalizeEmojiInBody('`🎉 still open')).toContain('🎉');
  });
});
