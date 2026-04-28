// Shortcode <-> unicode for the most common emojis. Messages always store
// emojis as :shortcode: per the API contract; the picker maps them to unicode
// for visual rendering, and falls back to literal text for unknown names.

export interface EmojiShortcode {
  name: string;
  unicode: string;
  keywords?: string[];
}

export const COMMON_EMOJI_SHORTCODES: EmojiShortcode[] = [
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
  // Emoticon stand-ins — surfaced via the text-emoji auto-convert pass
  // (`:)` → `:smile:` etc.), kept as separate names so the picker shows
  // them with the right semantic label.
  { name: 'smiley', unicode: '😀' },
  { name: 'disappointed', unicode: '😞', keywords: ['sad'] },
  { name: 'stuck_out_tongue', unicode: '😛', keywords: ['tongue'] },
  { name: 'laughing', unicode: '😆', keywords: ['lol'] },
  { name: 'neutral_face', unicode: '😐' },
];

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
// `:shortcode:` form the API stores. Built from the same table so
// adding to COMMON_EMOJI_SHORTCODES keeps both directions in sync.
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

// Map ASCII emoticons to the wrapped shortcode form they expand to,
// e.g. `:)` → `:smile:`. Storing the wrapped value (not just the name)
// lets the replace callback emit the result without an extra concat.
// Covered tokens are the classic IRC/messenger set; new entries auto-
// pick up the same boundary rules below.
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

// Single-pass replace covering both classes of replacement on prose
// segments: known unicode emoji (group 1) and ASCII emoticons (group 3,
// preceded by group 2's leading boundary). Combining them halves the
// per-segment regex work compared to two sequential `.replace()` calls.
//
// The emoticon arm requires the token stand alone — preceded by start-
// of-line or whitespace, followed by end-of-line, whitespace, or
// punctuation. Without that guard, `http://example.com:)` or
// `done; :)` adjacent to URLs / quoted text would silently rewrite.
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
    // Fenced code block — copy verbatim until the closing fence.
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
    // Inline code — copy verbatim until the closing backtick.
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
    // Find the next code-fence/backtick boundary so we only run the
    // emoji regex over plain prose.
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
