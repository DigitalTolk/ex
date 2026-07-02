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
