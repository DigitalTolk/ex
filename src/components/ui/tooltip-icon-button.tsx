import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// TooltipIconButton is a compact icon-only action for dense rows: the label is
// both the button's accessible name and the hover tooltip, so an icon never
// stands alone without a word for it. The app mounts one TooltipProvider at the
// root (see App.tsx), so callers just drop this in.
export function TooltipIconButton({
  label,
  children,
  onClick,
  disabled,
  className,
  pressed,
  testId,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  // For icon TOGGLES: exposes the on/off state as aria-pressed.
  pressed?: boolean;
  testId?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={className}
            aria-label={label}
            aria-pressed={pressed}
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
