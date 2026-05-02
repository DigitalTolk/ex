// Shortcode <-> unicode mapping for the full Unicode emoji set plus a
// hand-curated list of legacy GitHub-style aliases (so messages already
// stored with `:smile:` / `:thumbsup:` / `:tada:` keep rendering).
//
// The base dataset comes from CLDR via `unicode-emoji-json` and lives
// in emoji-data.generated.ts — re-run scripts/build-emoji-data.mjs to
// refresh it.

import { ALL_EMOJI, EMOJI_CATEGORIES, type EmojiEntry, type EmojiCategory } from './emoji-data.generated';

export interface EmojiShortcode {
  name: string;
  unicode: string;
  category?: string;
  keywords?: string[];
}

// LEGACY_ALIASES — GitHub/gemoji-style names retained for backwards
// compat with messages already in the database. Each entry's unicode
// must already exist in ALL_EMOJI; the alias just lets `:smile:` and
// `:grinning_face_with_smiling_eyes:` both resolve. Don't remove
// entries here — old stored messages depend on them.
const LEGACY_ALIASES: Array<{ name: string; unicode: string; keywords?: string[] }> = [
  { name: 'thumbsup', unicode: '👍', keywords: ['+1', 'yes', 'like'] },
  { name: 'thumbsdown', unicode: '👎', keywords: ['-1', 'no', 'dislike'] },
  { name: 'heart', unicode: '❤️', keywords: ['love'] },
  { name: 'joy', unicode: '😂', keywords: ['lol', 'laughing'] },
  { name: 'smile', unicode: '😄', keywords: ['happy'] },
  { name: 'grin', unicode: '😁' },
  { name: 'wink', unicode: '😉' },
  { name: 'sob', unicode: '😭', keywords: ['cry'] },
  { name: 'cry', unicode: '😢' },
  { name: 'rage', unicode: '😡', keywords: ['angry'] },
  { name: 'thinking', unicode: '🤔' },
  { name: 'open_mouth', unicode: '😮', keywords: ['wow', 'shocked'] },
  { name: 'tada', unicode: '🎉', keywords: ['party', 'celebrate'] },
  { name: 'fire', unicode: '🔥' },
  { name: 'rocket', unicode: '🚀' },
  { name: 'eyes', unicode: '👀' },
  { name: 'pray', unicode: '🙏', keywords: ['thanks', 'please'] },
  { name: 'clap', unicode: '👏' },
  { name: '100', unicode: '💯' },
  { name: 'check', unicode: '✅', keywords: ['yes', 'done'] },
  { name: 'x', unicode: '❌', keywords: ['no'] },
  { name: 'wave', unicode: '👋', keywords: ['hi', 'bye', 'hello'] },
  { name: 'sunglasses', unicode: '😎', keywords: ['cool'] },
  { name: 'bulb', unicode: '💡', keywords: ['idea'] },
  { name: 'warning', unicode: '⚠️' },
  { name: 'star', unicode: '⭐' },
  { name: 'heart_eyes', unicode: '😍' },
  { name: 'kiss', unicode: '😘' },
  { name: 'sweat_smile', unicode: '😅' },
  { name: 'sleeping', unicode: '😴' },
  { name: 'thinking_face', unicode: '🤨' },
  { name: 'sob2', unicode: '😩' },
  { name: 'flushed', unicode: '😳' },
  { name: 'shrug', unicode: '🤷' },
  { name: 'point_up', unicode: '☝️' },
  { name: 'point_right', unicode: '👉' },
  { name: 'muscle', unicode: '💪' },
  { name: 'ok_hand', unicode: '👌' },
  { name: 'raised_hands', unicode: '🙌' },
  { name: 'eyes_closed', unicode: '😌' },
  { name: 'sparkles', unicode: '✨' },
  { name: 'bug', unicode: '🐛' },
  { name: 'zap', unicode: '⚡' },
  { name: 'rainbow', unicode: '🌈' },
  { name: 'sun', unicode: '☀️' },
  { name: 'moon', unicode: '🌙' },
  { name: 'cloud', unicode: '☁️' },
  { name: 'snow', unicode: '❄️' },
  { name: 'coffee', unicode: '☕' },
  { name: 'beer', unicode: '🍺' },
  { name: 'pizza', unicode: '🍕' },
  { name: 'cookie', unicode: '🍪' },
  { name: 'apple', unicode: '🍎' },
  { name: 'cake', unicode: '🎂' },
  { name: 'gift', unicode: '🎁' },
  { name: 'computer', unicode: '💻' },
  { name: 'phone', unicode: '📱' },
  { name: 'email', unicode: '📧' },
  { name: 'lock', unicode: '🔒' },
  { name: 'key', unicode: '🔑' },
  { name: 'mag', unicode: '🔍' },
  { name: 'thumbsup_skin', unicode: '👍🏽' },
  { name: 'smiley', unicode: '😀' },
  { name: 'disappointed', unicode: '😞', keywords: ['sad'] },
  { name: 'stuck_out_tongue', unicode: '😛', keywords: ['tongue'] },
  { name: 'laughing', unicode: '😆', keywords: ['lol'] },
  { name: 'neutral_face', unicode: '😐' },
];

// COMMON_EMOJI_SHORTCODES is preserved as the union of the legacy
// alias set plus the full Unicode set. Existing call sites that
// iterated this list (picker, lexical typeahead) automatically pick
// up every emoji.
export const COMMON_EMOJI_SHORTCODES: EmojiShortcode[] = (() => {
  const seen = new Set<string>();
  const out: EmojiShortcode[] = [];
  // Legacy aliases first so a fuzzy search still surfaces familiar
  // names like `:smile:` ahead of CLDR's `:grinning_face_…:`.
  for (const e of LEGACY_ALIASES) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ name: e.name, unicode: e.unicode, keywords: e.keywords });
  }
  for (const e of ALL_EMOJI) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ name: e.name, unicode: e.unicode, category: e.category });
  }
  return out;
})();

export { EMOJI_CATEGORIES, ALL_EMOJI };
export type { EmojiEntry, EmojiCategory };

const NAME_TO_UNICODE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const e of COMMON_EMOJI_SHORTCODES) map[e.name] = e.unicode;
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
// `:shortcode:` form the API stores. Legacy aliases register first so
// `:smile:` wins over `:grinning_face_with_smiling_eyes:` for the
// common 😄 codepoint — keeps existing channels' history grep-friendly.
const UNICODE_TO_NAME: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const e of COMMON_EMOJI_SHORTCODES) {
    if (!(e.unicode in map)) map[e.unicode] = e.name;
  }
  return map;
})();

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

// ASCII emoticons that auto-expand to `:shortcode:` — IRC/messenger
// classics. The legacy aliases must remain in COMMON_EMOJI_SHORTCODES
// for these targets to resolve back to unicode at render time.
const TEXT_EMOJI_TO_SHORTCODE: Record<string, string> = {
  ':)': ':smile:',
  ':-)': ':smile:',
  ':D': ':smiley:',
  ':-D': ':smiley:',
  ';)': ':wink:',
  ';-)': ':wink:',
  ':(': ':disappointed:',
  ':-(': ':disappointed:',
  ':P': ':stuck_out_tongue:',
  ':p': ':stuck_out_tongue:',
  ':-P': ':stuck_out_tongue:',
  ':-p': ':stuck_out_tongue:',
  ':o': ':open_mouth:',
  ':O': ':open_mouth:',
  ':-o': ':open_mouth:',
  ':-O': ':open_mouth:',
  ':|': ':neutral_face:',
  ':-|': ':neutral_face:',
  '<3': ':heart:',
  ":'(": ':cry:',
  'xD': ':laughing:',
  'XD': ':laughing:',
};

// Single-pass replace: known unicode emoji (group 1) plus ASCII
// emoticon stand-alones (group 3 with leading boundary group 2). The
// alternation is generated from the full dataset so any emoji
// represented in COMMON_EMOJI_SHORTCODES can normalize back to its
// shortcode without runtime fallbacks.
const NORMALIZE_EMOJI_RE = (() => {
  const unicodeAlternation = COMMON_EMOJI_SHORTCODES
    .map((e) => e.unicode)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  const emoticonAlternation = Object.keys(TEXT_EMOJI_TO_SHORTCODE)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  return new RegExp(
    `(${unicodeAlternation})|(^|\\s)(${emoticonAlternation})(?=$|\\s|[.,!?;:])`,
    'g',
  );
})();

// normalizeEmojiInBody replaces every standalone unicode emoji in the
// body with its `:shortcode:` form AND auto-converts ASCII emoticons
// (`:)` `;)` `<3` …) to the same shortcode form. Skips text inside
// fenced code blocks and inline `code` spans — nobody wants
// `console.log("🎉")` or `if (x) :)` rewritten on the wire.
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
      (_m, unicodeToken: string | undefined, lead: string | undefined, emoticon: string | undefined) => {
        if (unicodeToken) return unicodeToShortcode(unicodeToken);
        return `${lead ?? ''}${TEXT_EMOJI_TO_SHORTCODE[emoticon ?? '']}`;
      },
    );
    i = next;
  }
  return out;
}
