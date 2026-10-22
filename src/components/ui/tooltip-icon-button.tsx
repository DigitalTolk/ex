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
  shortcut,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  // For icon TOGGLES: exposes the on/off state as aria-pressed.
  pressed?: boolean;
  testId?: string;
  // A keyboard shortcut for the same action, shown in the tooltip.
  shortcut?: { label: string; aria: string };
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
            aria-keyshortcuts={shortcut?.aria}
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && (
          <kbd data-slot="kbd" className="font-sans text-muted-foreground">
            {shortcut.label}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
