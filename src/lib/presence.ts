import type { CSSProperties } from 'react';

// Slack-style presence geometry, shared by every surface that shows a dot:
// the dot nests in a NOTCH masked out of the avatar itself, so the gap
// shows whatever really sits behind the avatar. (The old painted ring-2
// halo only matched one backdrop — every other surface had to pass a
// corrective ring color, and it read as a sticker floating OUTSIDE the
// avatar.) The dot itself lives in components/PresenceDot.tsx.
const PRESENCE_NOTCH_GAP = 2;

// presenceNotchStyle returns the mask that carves the dot's notch out of
// the avatar. `inset` is the dot's distance from the avatar's bottom-right
// corner (0 when the dot is flush, the PresenceDot default).
export function presenceNotchStyle(dotSize: number, inset = 0): CSSProperties {
  const c = inset + dotSize / 2;
  const r = dotSize / 2 + PRESENCE_NOTCH_GAP;
  const mask = `radial-gradient(circle ${r}px at calc(100% - ${c}px) calc(100% - ${c}px), transparent ${r - 0.5}px, #000 ${r}px)`;
  return { WebkitMaskImage: mask, maskImage: mask };
}

// ---- Shared dot geometry ----
// The React <PresenceDot> and the composer typeahead's plain-DOM renderer
// (CodeMirror option rows can't host React components) must stay visually
// identical. Both derive from these values; presenceDotParity.browser.test.tsx
// pins the computed styles against each other so they can't drift again.

// Default dot diameter in px, used wherever a caller doesn't size explicitly.
export const PRESENCE_DOT_DEFAULT_SIZE = 8;

// Hollow-ring stroke width for the offline state: proportional to the dot,
// but never thinner than 1.5px so the ring stays legible at small sizes.
export function presenceDotBorderWidth(size: number): number {
  return Math.max(1.5, size / 4.5);
}
