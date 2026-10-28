import type { ReactNode } from 'react';
import { Info, type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// InfoTip: a small (i) beside a label whose explanation shows on hover or
// focus, so settings stay to one line each. The text is also in the DOM as
// screen-reader-only copy, so it is never hidden from assistive tech (or
// from tests) behind a hover. `icon` swaps the (i) for a glyph that is itself
// the information (a lock on a locked connection, say).
export function InfoTip({ label, children, icon: Icon = Info }: { label: string; children: ReactNode; icon?: LucideIcon }) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`About ${label}`}
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
          }
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent className="max-w-72">{children}</TooltipContent>
      </Tooltip>
      <span className="sr-only">{children}</span>
    </>
  );
}
