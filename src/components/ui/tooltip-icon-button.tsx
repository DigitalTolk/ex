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
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
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
