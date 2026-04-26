import { shortcodeToUnicode } from '@/lib/emoji-shortcodes';

type EmojiGlyphSize = 'sm' | 'lg';

interface EmojiGlyphProps {
  emoji: string;
  customMap?: Record<string, string>;
  size?: EmojiGlyphSize;
  className?: string;
}

export function EmojiGlyph({ emoji, customMap, size = 'sm', className = '' }: EmojiGlyphProps) {
  const imgCls = size === 'lg' ? 'h-6 w-6' : 'h-3.5 w-3.5';
  const textCls = size === 'lg' ? 'text-2xl' : 'text-sm';

  if (emoji.startsWith(':') && emoji.endsWith(':') && emoji.length > 2) {
    const name = emoji.slice(1, -1);
    const url = customMap?.[name];
    if (url) {
      return (
        <img
          src={url}
          alt={emoji}
          title={emoji}
          className={`inline-block align-text-bottom ${imgCls} ${className}`}
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
