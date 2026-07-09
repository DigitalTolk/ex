import { describe, expect, it } from 'vitest';
import {
  shortcodeToUnicode,
  shortcodeWithSkinTone,
  applySkinToneSuffix,
  applyEmojiSkinTone,
  supportsEmojiSkinTone,
  unicodeToShortcode,
  normalizeEmojiInBody,
  EMOJI_SHORTCODE_RE,
  EMOJI_SHORTCODE_TONED_RE,
  EMOJI_SHORTCODE_RE_GLOBAL,
} from './emoji-shortcodes';

describe('shared emoji-shortcode grammar', () => {
  it('EMOJI_SHORTCODE_RE captures a plain :name:', () => {
    const m = EMOJI_SHORTCODE_RE.exec('say :smile: now');
    expect(m?.[1]).toBe('smile');
  });

  it('EMOJI_SHORTCODE_TONED_RE captures name + skin tone', () => {
    const m = EMOJI_SHORTCODE_TONED_RE.exec(':wave::skin-tone-3:');
    expect(m?.[1]).toBe('wave');
    expect(m?.[2]).toBe('skin-tone-3');
  });

  it('EMOJI_SHORTCODE_RE_GLOBAL scans both toned and plain forms', () => {
    const matches = [...':a::skin-tone-2: and :b:'.matchAll(EMOJI_SHORTCODE_RE_GLOBAL)];
    expect(matches.map((m) => [m[1], m[2]])).toEqual([
      ['a', 'skin-tone-2'],
      ['b', undefined],
    ]);
  });
});

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

  it('applySkinToneSuffix returns the unicode unchanged when the suffix is undefined', () => {
    // `SKIN_TONE_BY_SUFFIX.get(suffix ?? '')` → the `?? ''` side; '' is not a
    // known suffix so the lookup misses and the input is returned unchanged.
    expect(applySkinToneSuffix('👋', undefined)).toBe('👋');
  });

  it('applySkinToneSuffix applies the modifier for a recognised skin-tone suffix', () => {
    const out = applySkinToneSuffix('👋', 'skin-tone-2');
    // Result should be 👋 + the skin-tone-2 modifier (Fitzpatrick-2 codepoint).
    expect(out.length).toBeGreaterThan(1);
  });

  it('applyEmojiSkinTone falls back to the default tone for an unknown tone value', () => {
    // An unrecognised tone value drives the `?? SKIN_TONE_BY_VALUE.get('')`
    // fallback; the default tone has no modifier, so existing modifiers are
    // stripped and the base glyph returned.
    const out = applyEmojiSkinTone('👋🏽', 'no-such-tone' as never);
    expect(out).toBe('👋');
  });

  it('applyEmojiSkinTone applies a real modifier to a tone-capable base emoji', () => {
    // 👋 is Emoji_Modifier_Base → the `first && EMOJI_MODIFIER_BASE_RE.test`
    // true side runs and the modifier is appended.
    const out = applyEmojiSkinTone('👋', 'dark');
    expect(out).not.toBe('👋');
    expect(out.length).toBeGreaterThan('👋'.length);
  });

  it('applyEmojiSkinTone preserves a trailing variation selector when retoning', () => {
    // ☝️ (index pointing up + VS16) is a modifier-base; toning it must keep
    // the part after the VS16 stripped correctly (the `rest.startsWith(VS16)`
    // branch).
    const out = applyEmojiSkinTone('☝️', 'medium');
    expect(out).not.toBe('☝️');
  });

  it('shortcodeWithSkinTone embeds the suffix for a tone-capable emoji and chosen tone', () => {
    // 👋 supports tones and 'medium' has a suffix → the `suffix ? ... : ...`
    // truthy side returns `:wave::skin-tone-3:`.
    expect(shortcodeWithSkinTone('wave', '👋', 'medium')).toBe(':wave::skin-tone-3:');
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

  it('returns an empty string for an empty body (the `!body` guard)', () => {
    expect(normalizeEmojiInBody('')).toBe('');
  });
});
