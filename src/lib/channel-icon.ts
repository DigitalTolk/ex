import { isKnownEmoji } from '@/lib/emoji-shortcodes';

// channelEmoji is the emoji to draw for a channel's icon, in the form
// EmojiGlyph takes, or null when the channel has none ex can draw: it then
// keeps its globe or lock.
export function channelEmoji(icon?: string): string | null {
  if (!icon) return null;
  // A name: the server stores it without its colons.
  if (/^[a-z0-9_+-]+$/.test(icon)) return isKnownEmoji(icon) ? `:${icon}:` : null;
  return icon;
}
