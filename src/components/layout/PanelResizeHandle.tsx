import type { ComponentProps } from 'react';

interface Props extends Omit<ComponentProps<'div'>, 'className'> {
  /** Which edge of the PANEL the handle sits on. */
  edge: 'right' | 'left';
  testID: string;
}

// The draggable divider on a resizable layout panel. Invisible until hovered
// or focused (a neutral primary-tinted strip), straddling the panel edge so
// the grab target is 8px wide without adding layout width. Desktop-only
// chrome — mobile panels are full-width sheets with no resize affordance.
export function PanelResizeHandle({ edge, testID, ...handleProps }: Props) {
  return (
    <div
      {...handleProps}
      data-testid={testID}
      className={`absolute inset-y-0 z-30 w-2 cursor-col-resize touch-none outline-none transition-colors hover:bg-primary/20 focus-visible:bg-primary/30 active:bg-primary/30 mobile:hidden ${
        edge === 'right' ? 'right-0 translate-x-1/2' : 'left-0 -translate-x-1/2'
      }`}
    />
  );
}
