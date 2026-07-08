// Shortcode <-> unicode mapping for the generated Unicode emoji set.
// The dataset comes from CLDR via `unicode-emoji-json` and lives in
// emoji-data.generated.ts — re-run scripts/build-emoji-data.mjs to
// refresh it.

import {
  ALL_EMOJI as GENERATED_ALL_EMOJI,
  EMOJI_CATEGORIES,
  type EmojiEntry,
  type EmojiCategory,
} from './emoji-data.generated';

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
const CANONICAL_EMOJI_NAMES: Record<string, string> = {
  beam_face_smile_eyes: 'grin',
  flexed_biceps: 'muscle',
  person_bowing: 'bow',
  thinking_face: 'thinking',
};

export const ALL_EMOJI: EmojiEntry[] = GENERATED_ALL_EMOJI.map((emoji) => ({
  ...emoji,
  name: CANONICAL_EMOJI_NAMES[emoji.name] ?? emoji.name,
}));

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

export { EMOJI_CATEGORIES };
export type { EmojiEntry, EmojiCategory };

// Canonical emoji-shortcode grammar — the single source of truth shared by the
// message renderer (lib/markdown.tsx), the composer's live-preview glyph widget
// (markdown/extensions/emojiGlyphs.ts) and the autocomplete. A shortcode name is
// ASCII letters/digits with `_ + -`; an optional `::skin-tone-N` suffix selects
// a Fitzpatrick modifier. Keeping one definition guarantees the editor and the
// rendered message tokenize emoji identically.
const EMOJI_SHORTCODE_NAME = '[a-z0-9_+-]+';
// `:name::skin-tone-N:` — must be tested before the plain form (longer match).
export const EMOJI_SHORTCODE_TONED_RE = new RegExp(`:(${EMOJI_SHORTCODE_NAME})::(skin-tone-[1-5]):`, 'i');
// `:name:`
export const EMOJI_SHORTCODE_RE = new RegExp(`:(${EMOJI_SHORTCODE_NAME}):`, 'i');
// Global scan form with the skin-tone suffix optional — used to walk a buffer.
export const EMOJI_SHORTCODE_RE_GLOBAL = new RegExp(`:(${EMOJI_SHORTCODE_NAME})(?:::(skin-tone-[1-5]))?:`, 'gi');

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
// generated `:shortcode:` form the API stores. The builder is exported for
// tests: base entries always win over generated toned variants, which only
// matters if the catalog ever ships a pre-toned emoji as its own entry.
export function buildUnicodeToName(list: ReadonlyArray<{ unicode: string; name: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of list) map[e.unicode] = e.name;
  for (const e of list) {
    if (!supportsEmojiSkinTone(e.unicode)) continue;
    for (const tone of EMOJI_SKIN_TONES) {
      if (!tone.value) continue;
      const toned = applyEmojiSkinTone(e.unicode, tone.value);
      if (!(toned in map)) map[toned] = `${e.name}::${tone.suffix}`;
    }
  }
  return map;
}
const UNICODE_TO_NAME: Record<string, string> = buildUnicodeToName(ALL_EMOJI);

const ASCII_EMOJI_TO_SHORTCODE = new Map<string, string>([
  [':)', ':slightly_smile_face:'],
  [':-)', ':slightly_smile_face:'],
  [':(', ':slightly_frown_face:'],
  [':-(', ':slightly_frown_face:'],
  [';)', ':winking_face:'],
  [';-)', ':winking_face:'],
  [':D', ':smile:'],
  [':-D', ':smile:'],
  [':P', ':face_tongue:'],
  [':-P', ':face_tongue:'],
  [':p', ':face_tongue:'],
  [':-p', ':face_tongue:'],
  ['xD', ':laughing:'],
  ['XD', ':laughing:'],
  ['<3', ':heart:'],
]);

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
  const asciiAlternation = [...ASCII_EMOJI_TO_SHORTCODE.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  return new RegExp(`(${unicodeAlternation})|(?<!\\S)(${asciiAlternation})(?!\\S)`, 'g');
})();

// normalizeEmojiInBody replaces every known unicode emoji in the body
// with its generated `:shortcode:` form. Skips text inside
// fenced code blocks and inline `code` spans — nobody wants
// `console.log("🎉")` rewritten on the wire.
export function normalizeEmojiInBody(body: string): string {
  if (!body) return '';
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
      (token: string) => ASCII_EMOJI_TO_SHORTCODE.get(token) ?? unicodeToShortcode(token),
    );
    i = next;
  }
  return out;
}

// Matches a run of unicode emoji — a base pictographic char plus optional
// skin-tone modifiers, variation selectors, and ZWJ-joined sequences (so
// "👍🏽" and "👨‍👩‍👧" each count as one emoji run).
const EMOJI_UNICODE_RUN_RE = new RegExp(
  '\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E|\\p{Emoji_Modifier})?' +
    '(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E|\\p{Emoji_Modifier})?)*',
  'gu',
);

// isEmojiOnlyMessage reports whether a message body is nothing but emoji
// (custom `:shortcodes:`, standard shortcodes, or unicode emoji) plus
// whitespace. Used to render "jumbomoji" at double size. A `:shortcode:`
// only counts when it resolves to a real emoji or a known custom emoji,
// so a stray `:word:` doesn't get blown up as literal text.
export function isEmojiOnlyMessage(body: string, customEmoji?: Record<string, string>): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  let hadEmoji = false;
  let rest = trimmed.replace(EMOJI_SHORTCODE_RE_GLOBAL, (full, name: string) => {
    const isRealEmoji = shortcodeToUnicode(`:${name}:`) !== `:${name}:`;
    if (isRealEmoji || customEmoji?.[name]) {
      hadEmoji = true;
      return '';
    }
    return full;
  });
  rest = rest.replace(EMOJI_UNICODE_RUN_RE, () => {
    hadEmoji = true;
    return '';
  });
  return hadEmoji && rest.trim() === '';
}

// Tailwind classes for an emoji glyph/image in a rendered message, scaled up
// ("jumbomoji") when the whole message is emoji-only. Lives here (not in
// markdown.tsx) so both the legacy and hast render paths can import it
// without forming a markdown ↔ markdown-hast import cycle.
export function emojiGlyphClass(large: boolean | undefined): string {
  return large ? 'text-[2.8em] leading-none align-middle' : 'text-[1.4em] leading-none align-middle';
}
export function emojiImageClass(large: boolean | undefined): string {
  return large
    ? 'inline-block h-[2.8em] w-[2.8em] align-middle'
    : 'inline-block h-[1.4em] w-[1.4em] align-middle';
}
