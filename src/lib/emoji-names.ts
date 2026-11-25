import { isKnownEmoji } from '@/lib/emoji-shortcodes';

// nameClash says why a shortcode can't be used, as you type it: a standard
// emoji has it (a custom one would stand in for that emoji everywhere), or a
// custom one does. The server refuses both with the same words.
export function nameClash(name: string, custom: { name: string }[] | undefined): string | null {
  if (!name) return null;
  if (isKnownEmoji(name)) return `:${name}: is already a standard emoji. Pick another name.`;
  if (custom?.some((e) => e.name === name)) return `There's already a custom emoji called :${name}:. Pick another name.`;
  return null;
}
