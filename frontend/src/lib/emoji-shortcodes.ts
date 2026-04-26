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
