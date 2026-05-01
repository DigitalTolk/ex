import { describe, it, expect } from 'vitest';
import { pickPlacement } from './typeaheadPlacement';

// jsdom returns 0×0 bounding rects so an end-to-end test of the
// flip-above behaviour wouldn't actually exercise the geometry.
// pickPlacement is the pure decision split out of the layout effect;
// covering its branches here is the only way to lock it in.
function rect(top: number, height: number): DOMRect {
  return {
    top, bottom: top + height, height,
    left: 0, right: 0, width: 0, x: 0, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('TypeaheadMenu pickPlacement', () => {
  it('places below when there is room beneath the anchor', () => {
    // Anchor near the top of an 800-tall viewport, menu only 200 tall.
    expect(pickPlacement(rect(100, 20), rect(0, 200), 800)).toBe('below');
  });

  it('flips above when below would overflow the viewport bottom', () => {
    // Chat composer scenario: trigger near the viewport bottom.
    // Anchor at y=780–800 (just below visible area), menu 240 tall —
    // 800+240+8 > 800 (overflows below), 780-240-8=532 > 0 (fits above).
    expect(pickPlacement(rect(780, 20), rect(0, 240), 800)).toBe('above');
  });

  it('keeps below when neither side has room (small viewport)', () => {
    // Tiny viewport: menu can't fit either above or below the anchor.
    // Below stays the default — the menu's own scroll handles overflow.
    expect(pickPlacement(rect(50, 20), rect(0, 240), 100)).toBe('below');
  });

  it('flips above when anchor is at the very bottom of the viewport', () => {
    // Edge case: anchor.bottom === viewportHeight. Adding SAFE_MARGIN
    // makes overflow strictly true; above must be chosen if there's
    // room (480 px).
    expect(pickPlacement(rect(480, 20), rect(0, 240), 500)).toBe('above');
  });
});
