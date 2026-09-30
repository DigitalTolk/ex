import { EmojiGlyph } from '@/components/EmojiGlyph';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useEmojiMap } from '@/hooks/useEmoji';
import { activeStatus, formatStatusUntil } from '@/lib/user-status';
import type { UserStatus } from '@/types';

interface UserStatusIndicatorProps {
  status?: UserStatus | null;
  className?: string;
  tooltip?: boolean;
  // Render the tooltip trigger as a <span> instead of a <button> — for when
  // the indicator sits inside another button (e.g. the sidebar account menu
  // trigger), where a nested button would be invalid.
  inlineTrigger?: boolean;
}

export function UserStatusIndicator({ status, className = '', tooltip = true, inlineTrigger = false }: UserStatusIndicatorProps) {
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
          render={inlineTrigger ? <span /> : undefined}
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
