import { shortcodeToUnicode } from '@/lib/emoji-shortcodes';

type EmojiGlyphSize = 'sm' | 'lg' | 'xl';

interface EmojiGlyphProps {
  emoji: string;
  customMap?: Record<string, string>;
  size?: EmojiGlyphSize;
  className?: string;
}

export function EmojiGlyph({ emoji, customMap, size = 'sm', className = '' }: EmojiGlyphProps) {
  // 'lg' is sized at −2px from text-2xl to match the picker grid's
  // visual rhythm; 'xl' is the hero size used in tooltips and intros.
  const imgCls =
    size === 'xl' ? 'h-16 w-16' : size === 'lg' ? 'h-[22px] w-[22px]' : 'h-3.5 w-3.5';
  const textCls =
    size === 'xl' ? 'text-[64px]' : size === 'lg' ? 'text-[22px]' : 'text-sm';

  if (emoji.startsWith(':') && emoji.endsWith(':') && emoji.length > 2) {
    const name = emoji.slice(1, -1);
    const url = customMap?.[name];
    if (url) {
      return (
        <img
          src={url}
          alt={emoji}
          title={emoji}
          className={`inline-block align-middle ${imgCls} ${className}`}
        />
      );
    }
    return (
      <span title={emoji} className={`leading-none ${textCls} ${className}`}>
        {shortcodeToUnicode(emoji)}
      </span>
    );
  }
  return <span className={`leading-none ${textCls} ${className}`}>{emoji}</span>;
}
