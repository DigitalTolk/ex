// Pure decision logic for the mobile channel drag-to-open gesture, split
// out of AppLayout so it's unit-testable without driving Motion's
// pointer-based pan gesture (which needs a real browser).

// A horizontal travel past CHANNEL_OPEN_PX_THRESHOLD commits, as does a
// quick flick that exceeds CHANNEL_OPEN_VELOCITY_THRESHOLD even if the
// absolute travel is shorter (but at least CHANNEL_OPEN_MIN_DELTA_TO_COMMIT).
export const CHANNEL_OPEN_PX_THRESHOLD = 80;
export const CHANNEL_OPEN_VELOCITY_THRESHOLD = 0.45; // px/ms
// Opening only latches when the gesture starts within this many px of the
// left edge, so mid-screen horizontal drags don't yank the sidebar in.
export const CHANNEL_OPEN_EDGE_PX = 36;
export const CHANNEL_OPEN_MIN_DELTA_TO_COMMIT = 56;
// How far the finger must travel before we lock onto the horizontal axis.
export const CHANNEL_OPEN_AXIS_LOCK_PX = 12;

export type ChannelSwipeIntent = 'open' | 'close' | null;

// Decide, on the first clearly-horizontal move of a gesture, whether it
// expresses an open or close intent (or neither). Returns null while the
// move is too small/vertical to act on.
export function latchChannelSwipe(p: {
  absX: number;
  absY: number;
  deltaX: number;
  startX: number;
  mobileChannelsOpen: boolean;
  canOpen: boolean;
}): ChannelSwipeIntent {
  if (p.absX < CHANNEL_OPEN_AXIS_LOCK_PX) return null;
  if (p.absY >= p.absX) return null;
  const isEdgeStart = p.startX <= CHANNEL_OPEN_EDGE_PX;
  if (!p.mobileChannelsOpen && p.deltaX > 0 && isEdgeStart && p.canOpen) return 'open';
  if (p.mobileChannelsOpen && p.deltaX < 0) return 'close';
  return null;
}

// Clamp the live drag offset to the dismiss direction so iOS inertia
// overshoot can't push the panel the wrong way.
export function clampChannelOffset(
  intent: 'open' | 'close',
  deltaX: number,
  viewportWidth: number,
): number {
  if (intent === 'open') return Math.max(0, Math.min(viewportWidth, deltaX));
  return Math.max(-viewportWidth, Math.min(0, deltaX));
}

// The CSS transform for the main content area: the resting open/closed
// position with the live drag offset blended on top.
export function channelDragTransform(channelDragOffset: number, mobileChannelsOpen: boolean): string {
  const restingX = mobileChannelsOpen ? '100vw' : '0px';
  if (channelDragOffset === 0) return `translate3d(${restingX}, 0, 0)`;
  const sign = channelDragOffset > 0 ? '+' : '-';
  const abs = Math.round(Math.abs(channelDragOffset));
  return `translate3d(calc(${restingX} ${sign} ${abs}px), 0, 0)`;
}

// On release, decide whether a latched gesture has travelled far/fast
// enough to commit.
export function shouldCommitChannelSwipe(p: { absX: number; velocityPxPerMs: number }): boolean {
  const flicked = p.velocityPxPerMs > CHANNEL_OPEN_VELOCITY_THRESHOLD;
  const meetsPixelThreshold = p.absX >= CHANNEL_OPEN_PX_THRESHOLD;
  const meetsMinDelta = p.absX >= CHANNEL_OPEN_MIN_DELTA_TO_COMMIT;
  return (flicked && meetsMinDelta) || meetsPixelThreshold;
}
