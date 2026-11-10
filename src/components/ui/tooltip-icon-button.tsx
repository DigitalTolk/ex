import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// TooltipIconButton is a compact icon-only action for dense rows: the label is
// both the button's accessible name and the hover tooltip, so an icon never
// stands alone without a word for it. The app mounts one TooltipProvider at the
// root (see App.tsx), so callers just drop this in.
export function TooltipIconButton({
  label,
  ariaLabel = label,
  children,
  onClick,
  disabled,
  className,
  pressed,
  expanded,
  testId,
  shortcut,
  size = 'icon-xs',
}: {
  label: string;
  // The accessible name, when the tooltip's word needs more to be told apart
  // from its neighbours' ("Edit" in a list of rows is "Edit Alerts").
  ariaLabel?: string;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  // For icon TOGGLES: exposes the on/off state as aria-pressed.
  pressed?: boolean;
  // For a button that shows and hides a section: aria-expanded.
  expanded?: boolean;
  testId?: string;
  // A keyboard shortcut for the same action, shown in the tooltip.
  shortcut?: { label: string; aria: string };
  size?: 'icon-xs' | 'icon-sm';
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={size}
            className={className}
            aria-label={ariaLabel}
            aria-pressed={pressed}
            aria-expanded={expanded}
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
          // Plain muted text after the label: no data-slot="kbd", which
          // would take the tooltip's padding for a key chip this isn't.
          <kbd className="font-sans text-muted-foreground">
            {shortcut.label}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
