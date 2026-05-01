// Vertical placement of the typeahead menu relative to Lexical's
// anchor div. The anchor sits at the bottom of the trigger character;
// "below" stacks the menu downward from there, "above" lifts it up to
// clear the viewport bottom when the trigger is close to the screen
// edge (typical for chat composers, which sit at the bottom).
export type Placement = 'below' | 'above';

const SAFE_MARGIN_PX = 8;

/**
 * Pure decision: pick the side of the anchor where the menu fits.
 * Split out of the layout effect so it's unit-testable — jsdom returns
 * zero-sized rects, so an integration test in the editor suite can't
 * actually exercise the geometry. The corresponding tests live in
 * typeaheadPlacement.test.ts.
 */
export function pickPlacement(anchor: DOMRect, menu: DOMRect, viewportHeight: number): Placement {
  const overflowsBottom = anchor.bottom + menu.height + SAFE_MARGIN_PX > viewportHeight;
  if (!overflowsBottom) return 'below';
  const fitsAbove = anchor.top - menu.height - SAFE_MARGIN_PX > 0;
  return fitsAbove ? 'above' : 'below';
}
