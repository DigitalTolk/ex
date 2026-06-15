import { describe, expect, it } from 'vitest';
import {
  shortcodeToUnicode,
  shortcodeWithSkinTone,
  applySkinToneSuffix,
  applyEmojiSkinTone,
  supportsEmojiSkinTone,
  EMOJI_SKIN_TONES,
} from './emoji-shortcodes';

// Browser-gate coverage for the emoji skin-tone helpers' edge branches.

const WAVE = '👋'; // a skin-tone-capable emoji
const realSuffix = EMOJI_SKIN_TONES.find((t) => t.value)!.suffix;
const realTone = EMOJI_SKIN_TONES.find((t) => t.value)!.value;

describe('emoji-shortcodes skin-tone helpers (browser)', () => {
  it('shortcodeToUnicode returns the input unchanged for a non-shortcode or unknown name', () => {
    expect(shortcodeToUnicode('plain text')).toBe('plain text');
    expect(shortcodeToUnicode(':totally_unknown_xyz:')).toBe(':totally_unknown_xyz:');
  });

  it('shortcodeWithSkinTone appends the suffix for a tone-capable emoji', () => {
    expect(shortcodeWithSkinTone('wave', WAVE, realTone)).toBe(`:wave::${realSuffix}:`);
  });

  it('shortcodeWithSkinTone returns the plain shortcode for a non-tonable emoji or no tone', () => {
    expect(shortcodeWithSkinTone('smile', '😄', realTone)).toBe(':smile:');
    expect(shortcodeWithSkinTone('wave', WAVE, '')).toBe(':wave:');
  });

  it('applySkinToneSuffix applies a known suffix and passes through an unknown one', () => {
    expect(typeof applySkinToneSuffix(WAVE, realSuffix)).toBe('string');
    expect(applySkinToneSuffix(WAVE, 'not-a-real-suffix')).toBe(WAVE);
  });

  it('applyEmojiSkinTone strips the modifier when no tone is given and tolerates empty input', () => {
    expect(typeof applyEmojiSkinTone(WAVE, undefined)).toBe('string');
    expect(applyEmojiSkinTone('', realTone)).toBe('');
  });

  it('supportsEmojiSkinTone is false for an empty string', () => {
    expect(supportsEmojiSkinTone('')).toBe(false);
    expect(supportsEmojiSkinTone(WAVE)).toBe(true);
  });
});

import { isEmojiOnlyMessage } from './emoji-shortcodes';

describe('isEmojiOnlyMessage', () => {
  it('returns false for an empty or whitespace body', () => {
    expect(isEmojiOnlyMessage('')).toBe(false);
    expect(isEmojiOnlyMessage('   ')).toBe(false);
  });

  it('detects a single real emoji shortcode', () => {
    expect(isEmojiOnlyMessage(':smile:')).toBe(true);
  });

  it('detects multiple emoji and surrounding whitespace', () => {
    expect(isEmojiOnlyMessage(':smile: :tada:')).toBe(true);
  });

  it('detects a unicode emoji', () => {
    expect(isEmojiOnlyMessage('🎉')).toBe(true);
  });

  it('detects a custom emoji via the provided map', () => {
    expect(isEmojiOnlyMessage(':partyparrot:', { partyparrot: 'https://x/p.gif' })).toBe(true);
  });

  it('is false when emoji are mixed with text', () => {
    expect(isEmojiOnlyMessage('nice :smile:')).toBe(false);
  });

  it('is false for an unknown shortcode that is neither real nor custom', () => {
    expect(isEmojiOnlyMessage(':definitelynotanemoji:')).toBe(false);
  });
});
