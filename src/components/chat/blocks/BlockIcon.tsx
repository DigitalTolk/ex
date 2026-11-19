import { EmojiGlyph } from '@/components/EmojiGlyph';
import { isKnownEmoji } from '@/lib/emoji-shortcodes';

// BlockIcon draws a callout's or a card's icon: the emoji itself, or a name
// ex knows. A name it doesn't know draws nothing rather than ":name:".
export function BlockIcon({ icon, size, className }: { icon: string; size: 'md' | 'lg'; className?: string }) {
  if (/^[a-z0-9_+-]+$/.test(icon)) {
    return isKnownEmoji(icon) ? <EmojiGlyph emoji={`:${icon}:`} size={size} className={className} /> : null;
  }
  return <EmojiGlyph emoji={icon} size={size} className={className} />;
}
