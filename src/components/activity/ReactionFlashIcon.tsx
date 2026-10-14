import { EmojiGlyph } from '@/components/EmojiGlyph';
import { useEmojiMap } from '@/hooks/useEmoji';
import type { ReactionFlash } from '@/stores/reaction-flash';

// The Activity bell's stand-in while a reaction flashes: the emoji itself,
// popping in. Mounted only for the flash, so the custom-emoji map is read
// only then.
export function ReactionFlashIcon({ flash, className = '' }: { flash: ReactionFlash; className?: string }) {
  const { data: emojiMap } = useEmojiMap();
  return (
    <span
      key={flash.seq}
      className={`flex items-center justify-center animate-in zoom-in-50 duration-200 motion-reduce:animate-none ${className}`}
      role="img"
      aria-label={`Reaction ${flash.emoji}`}
      data-testid="activity-reaction-flash"
    >
      <EmojiGlyph emoji={flash.emoji} customMap={emojiMap} size="md" />
    </span>
  );
}
