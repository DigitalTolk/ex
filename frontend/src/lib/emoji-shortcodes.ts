// Shortcode <-> unicode mapping for the generated Unicode emoji set.
// The dataset comes from CLDR via `unicode-emoji-json` and lives in
// emoji-data.generated.ts — re-run scripts/build-emoji-data.mjs to
// refresh it.

import { ALL_EMOJI, EMOJI_CATEGORIES, type EmojiEntry, type EmojiCategory } from './emoji-data.generated';

export interface EmojiShortcode {
  name: string;
  unicode: string;
  category?: string;
  keywords?: string[];
}

export type EmojiSkinTone = '' | 'light' | 'medium_light' | 'medium' | 'medium_dark' | 'dark';

export const EMOJI_SKIN_TONES: Array<{
  value: EmojiSkinTone;
  label: string;
  swatch: string;
  modifier: string;
  suffix: string;
}> = [
  { value: '', label: 'Default', swatch: '👍', modifier: '', suffix: '' },
  { value: 'light', label: 'Light skin tone', swatch: '👍🏻', modifier: '🏻', suffix: 'skin-tone-1' },
  { value: 'medium_light', label: 'Medium-light skin tone', swatch: '👍🏼', modifier: '🏼', suffix: 'skin-tone-2' },
  { value: 'medium', label: 'Medium skin tone', swatch: '👍🏽', modifier: '🏽', suffix: 'skin-tone-3' },
  { value: 'medium_dark', label: 'Medium-dark skin tone', swatch: '👍🏾', modifier: '🏾', suffix: 'skin-tone-4' },
  { value: 'dark', label: 'Dark skin tone', swatch: '👍🏿', modifier: '🏿', suffix: 'skin-tone-5' },
];

const SKIN_TONE_BY_VALUE = new Map(EMOJI_SKIN_TONES.map((t) => [t.value, t]));
const SKIN_TONE_BY_SUFFIX = new Map(EMOJI_SKIN_TONES.filter((t) => t.suffix).map((t) => [t.suffix, t]));
const EMOJI_MODIFIER_BASE_RE = /^\p{Emoji_Modifier_Base}/u;
const EMOJI_MODIFIER_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const VARIATION_SELECTOR_16 = '\uFE0F';
const ZERO_WIDTH_JOINER = '\u200D';

export function applyEmojiSkinTone(unicode: string, tone: EmojiSkinTone | undefined): string {
  const skinTone = SKIN_TONE_BY_VALUE.get(tone ?? '') ?? SKIN_TONE_BY_VALUE.get('');
  if (!skinTone?.modifier) return unicode.replace(EMOJI_MODIFIER_RE, '');

  const normalized = unicode.replace(EMOJI_MODIFIER_RE, '');
  const first = Array.from(normalized)[0] ?? '';
  if (!first || !EMOJI_MODIFIER_BASE_RE.test(first)) return unicode;

  const rest = normalized.slice(first.length);
  if (rest.startsWith(VARIATION_SELECTOR_16)) {
    return `${first}${skinTone.modifier}${rest.slice(VARIATION_SELECTOR_16.length)}`;
  }
  return `${first}${skinTone.modifier}${rest}`;
}

export function supportsEmojiSkinTone(unicode: string): boolean {
  if (unicode.includes(ZERO_WIDTH_JOINER)) return false;
  const first = Array.from(unicode.replace(EMOJI_MODIFIER_RE, ''))[0] ?? '';
  return !!first && EMOJI_MODIFIER_BASE_RE.test(first);
}

export const COMMON_EMOJI_SHORTCODES: EmojiShortcode[] = ALL_EMOJI;

export { EMOJI_CATEGORIES, ALL_EMOJI };
export type { EmojiEntry, EmojiCategory };

const NAME_TO_UNICODE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const e of ALL_EMOJI) map[e.name] = e.unicode;
  for (const tone of EMOJI_SKIN_TONES) {
    if (!tone.suffix) continue;
    map[tone.suffix] = tone.modifier;
  }
  return map;
})();

// shortcodeToUnicode resolves :name: to its unicode form, or returns the
// shortcode unchanged if unknown.
export function shortcodeToUnicode(shortcode: string): string {
  const m = /^:([a-z0-9_+-]+):$/i.exec(shortcode);
  if (!m) return shortcode;
  return NAME_TO_UNICODE[m[1]] ?? shortcode;
}

// Inverse map for normalizing user-typed unicode emoji back to the
// generated `:shortcode:` form the API stores.
const UNICODE_TO_NAME: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const e of ALL_EMOJI) map[e.unicode] = e.name;
  for (const e of ALL_EMOJI) {
    if (!supportsEmojiSkinTone(e.unicode)) continue;
    for (const tone of EMOJI_SKIN_TONES) {
      if (!tone.value) continue;
      const toned = applyEmojiSkinTone(e.unicode, tone.value);
      if (!(toned in map)) map[toned] = `${e.name}::${tone.suffix}`;
    }
  }
  return map;
})();

export function shortcodeWithSkinTone(name: string, unicode: string, tone: EmojiSkinTone | undefined): string {
  if (!tone || !supportsEmojiSkinTone(unicode)) return `:${name}:`;
  const suffix = SKIN_TONE_BY_VALUE.get(tone)?.suffix;
  return suffix ? `:${name}::${suffix}:` : `:${name}:`;
}

export function applySkinToneSuffix(unicode: string, suffix: string | undefined): string {
  const tone = SKIN_TONE_BY_SUFFIX.get(suffix ?? '');
  return tone ? applyEmojiSkinTone(unicode, tone.value) : unicode;
}

// unicodeToShortcode returns `:name:` for a single emoji codepoint
// sequence, or the input unchanged if no shortcode is known. Used by
// normalizeEmojiInBody to flatten device-picker emojis at send time.
export function unicodeToShortcode(unicode: string): string {
  const name = UNICODE_TO_NAME[unicode];
  return name ? `:${name}:` : unicode;
}

// Escape a literal string for safe inclusion in a `RegExp(...)` source.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Single-pass replace for known unicode emoji. The alternation is generated
// from the full dataset so picker, typeahead, rendering, and native emoji
// normalization share the same canonical shortcode names.
const NORMALIZE_EMOJI_RE = (() => {
  const unicodeAlternation = [...new Set([...ALL_EMOJI.map((e) => e.unicode), ...Object.keys(UNICODE_TO_NAME)])]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  return new RegExp(`(${unicodeAlternation})`, 'g');
})();

// normalizeEmojiInBody replaces every known unicode emoji in the body
// with its generated `:shortcode:` form. Skips text inside
// fenced code blocks and inline `code` spans — nobody wants
// `console.log("🎉")` rewritten on the wire.
export function normalizeEmojiInBody(body: string): string {
  let out = '';
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('```', i)) {
      const end = body.indexOf('```', i + 3);
      if (end === -1) {
        out += body.slice(i);
        break;
      }
      out += body.slice(i, end + 3);
      i = end + 3;
      continue;
    }
    if (body[i] === '`') {
      const end = body.indexOf('`', i + 1);
      if (end === -1) {
        out += body.slice(i);
        break;
      }
      out += body.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    let next = body.length;
    const fence = body.indexOf('```', i);
    if (fence !== -1 && fence < next) next = fence;
    const tick = body.indexOf('`', i);
    if (tick !== -1 && tick < next) next = tick;
    out += body.slice(i, next).replace(
      NORMALIZE_EMOJI_RE,
      (unicodeToken: string) => unicodeToShortcode(unicodeToken),
    );
    i = next;
  }
  return out;
}
