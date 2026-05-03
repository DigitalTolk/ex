import { EmojiGlyph } from '@/components/EmojiGlyph';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useEmojiMap } from '@/hooks/useEmoji';
import { activeStatus, formatStatusUntil } from '@/lib/user-status';
import type { UserStatus } from '@/types';

interface UserStatusIndicatorProps {
  status?: UserStatus | null;
  className?: string;
  tooltip?: boolean;
}

export function UserStatusIndicator({ status, className = '', tooltip = true }: UserStatusIndicatorProps) {
  const current = activeStatus(status);
  const { data: emojiMap = {} } = useEmojiMap(!!current);
  if (!current) return null;
  const indicator = (
    <span
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center align-middle ${className}`}
      aria-label={`${current.text}, ${formatStatusUntil(current.clearAt)}`}
    >
      <EmojiGlyph emoji={current.emoji} customMap={emojiMap} />
    </span>
  );

  if (!tooltip) return indicator;

  return (
    <TooltipProvider delay={500}>
      <Tooltip>
        <TooltipTrigger
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center align-middle ${className}`}
          aria-label={`${current.text}, ${formatStatusUntil(current.clearAt)}`}
        >
          <EmojiGlyph emoji={current.emoji} customMap={emojiMap} />
        </TooltipTrigger>
        <TooltipContent side="top" className="block w-48 p-3 text-center">
          <div className="flex flex-col items-center justify-center gap-2 text-center">
            <EmojiGlyph emoji={current.emoji} customMap={emojiMap} size="xl" />
            <div className="font-medium">{current.text}</div>
            <div className="text-muted-foreground">{formatStatusUntil(current.clearAt)}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
