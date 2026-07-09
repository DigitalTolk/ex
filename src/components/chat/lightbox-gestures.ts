// Gesture state machine for the lightbox pointer pipeline.
//
// Replaces four parallel refs (pan / swipe / pinch / tap-start) with
// a single tagged-union `GestureState`. The mutual exclusivity that
// was previously enforced by manual null-outs across handlers
// ("pinch starts → null swipe and pan") is now structural: only one
// kind of state can be active at a time, by definition of a tagged
// union.
//
// The module is pure — no DOM, no React. Inputs are plain pointer
// snapshots {pointerId, x, y, t}. Callers (ImageLightbox) hold the
// state in a ref and feed events via the helpers below; the helpers
// return both the next state and an `Intent` describing what the
// caller should do (zoom, pan, swipe, navigate, close, tap).

export type Pointer = { pointerId: number; x: number; y: number };

export type GestureState =
  | { kind: 'idle' }
  | { kind: 'tap-pending'; pointerId: number; startTime: number; startX: number; startY: number }
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; originX: number; originY: number }
  | { kind: 'swipe'; pointerId: number; startX: number; startY: number; lastX: number; lastY: number }
  | { kind: 'pinch'; startDistance: number; startZoom: number; centerX: number; centerY: number; originX: number; originY: number };

export const idleGesture: GestureState = { kind: 'idle' };

export interface GestureContext {
  isImage: boolean;
  isMobile: boolean;
  zoom: number;
  panX: number;
  panY: number;
}

export interface PinchSnapshot {
  zoom: number;
  panX: number;
  panY: number;
}

export interface PanSnapshot {
  panX: number;
  panY: number;
}

export interface SwipeOutcome {
  kind: 'close' | 'next' | 'prev' | 'none';
  dx: number;
  dy: number;
}

const TAP_MAX_MS = 350;
const TAP_MAX_DISTANCE = 12;
const SWIPE_MIN_DISTANCE = 70;
const SWIPE_MOVEMENT_THRESHOLD = 12;
const SWIPE_AXIS_RATIO = 1.15;
const DOUBLE_TAP_MAX_MS = 450;
const DOUBLE_TAP_MAX_DISTANCE = 56;

export function distance(a: Pointer, b: Pointer): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function center(a: Pointer, b: Pointer): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Decide what state pointerdown should produce.
//
//   isImage + ≥2 pointers → pinch (always wins over pan/swipe)
//   isImage + zoom > 1   → pan
//   isMobile             → swipe-pending
//   anything else        → idle (mouse drag on desktop, etc.)
//
// A tap-pending snapshot is only captured for the FIRST pointer on
// mobile touch input — subsequent pointers cancel the tap.
export function onPointerDown(
  prev: GestureState,
  pointer: Pointer & { pointerType: string; time: number },
  activePointers: Pointer[],
  ctx: GestureContext,
): { state: GestureState; tapStart: GestureState | null } {
  // A first finger landing on the image stage on mobile is always a
  // tap candidate — until it either moves (cancels the tap) or
  // releases stationary (commits the tap). Tap candidacy is parallel
  // to whatever physical gesture state the touch belongs to.
  const tapEligible =
    ctx.isImage && ctx.isMobile && pointer.pointerType !== 'mouse' && activePointers.length === 1;
  const tapStart: GestureState | null = tapEligible
    ? { kind: 'tap-pending', pointerId: pointer.pointerId, startTime: pointer.time, startX: pointer.x, startY: pointer.y }
    : null;
  // Pinch wins as soon as a second pointer joins on an image.
  if (ctx.isImage && activePointers.length >= 2) {
    const [a, b] = activePointers.slice(0, 2);
    const c = center(a, b);
    return {
      state: {
        kind: 'pinch',
        startDistance: Math.max(1, distance(a, b)),
        startZoom: ctx.zoom,
        centerX: c.x,
        centerY: c.y,
        originX: ctx.panX,
        originY: ctx.panY,
      },
      tapStart: null,
    };
  }
  if (ctx.isImage && ctx.zoom > 1) {
    return {
      state: {
        kind: 'pan',
        pointerId: pointer.pointerId,
        startX: pointer.x,
        startY: pointer.y,
        originX: ctx.panX,
        originY: ctx.panY,
      },
      tapStart,
    };
  }
  if (ctx.isMobile) {
    return {
      state: {
        kind: 'swipe',
        pointerId: pointer.pointerId,
        startX: pointer.x,
        startY: pointer.y,
        lastX: pointer.x,
        lastY: pointer.y,
      },
      tapStart,
    };
  }
  // Desktop, no zoom — pointerdown is essentially a no-op for gesture
  // purposes (clicks bubble up to button handlers normally).
  return { state: prev.kind === 'idle' ? prev : { kind: 'idle' }, tapStart: null };
}

// Pinch / pan move handlers translate pointer-move events into
// concrete transform updates. Both return `null` to indicate the
// caller should not preventDefault — they only return a transform
// when the gesture is actively driving the image.

export function readPinchUpdate(
  state: GestureState,
  activePointers: Pointer[],
  imageDevicePixelMaxZoom = 6,
): PinchSnapshot | null {
  if (state.kind !== 'pinch' || activePointers.length < 2) return null;
  const [a, b] = activePointers.slice(0, 2);
  const dist = Math.max(1, distance(a, b));
  const c = center(a, b);
  const nextZoom = Math.min(
    imageDevicePixelMaxZoom,
    Math.max(1, Math.round((state.startZoom * dist / state.startDistance) * 100) / 100),
  );
  return {
    zoom: nextZoom,
    panX: state.originX + c.x - state.centerX,
    panY: state.originY + c.y - state.centerY,
  };
}

export function readPanUpdate(state: GestureState, pointer: Pointer): PanSnapshot | null {
  if (state.kind !== 'pan' || state.pointerId !== pointer.pointerId) return null;
  return {
    panX: state.originX + pointer.x - state.startX,
    panY: state.originY + pointer.y - state.startY,
  };
}

// readSwipeDrag: produce the drag offset to apply to the stage so the
// user gets visual feedback before commitment. The caller decides
// whether to commit (close / navigate) on pointerup via classifySwipe.
export function readSwipeDrag(
  state: GestureState,
  pointer: Pointer,
): { dx: number; dy: number } | null {
  if (state.kind !== 'swipe' || state.pointerId !== pointer.pointerId) return null;
  const dx = pointer.x - state.startX;
  const dy = pointer.y - state.startY;
  if (Math.max(Math.abs(dx), Math.abs(dy)) <= SWIPE_MOVEMENT_THRESHOLD) return null;
  const horizontal = Math.abs(dx) > Math.abs(dy) * SWIPE_AXIS_RATIO;
  const vertical = dy > 0 && Math.abs(dy) > Math.abs(dx) * SWIPE_AXIS_RATIO;
  return { dx: horizontal ? dx : 0, dy: vertical ? Math.max(0, dy) : 0 };
}

// trackSwipeEnd records the latest pointer position into the swipe
// state — we read it at pointerup to compute the final delta.
export function trackSwipe(state: GestureState, pointer: Pointer): GestureState {
  if (state.kind !== 'swipe' || state.pointerId !== pointer.pointerId) return state;
  return { ...state, lastX: pointer.x, lastY: pointer.y };
}

// Tap-pending snapshots are invalidated as soon as the finger moves
// past the tap-distance threshold.
export function tryInvalidateTap(
  tap: GestureState | null,
  pointer: Pointer,
): GestureState | null {
  if (!tap || tap.kind !== 'tap-pending' || tap.pointerId !== pointer.pointerId) return tap;
  if (Math.hypot(pointer.x - tap.startX, pointer.y - tap.startY) > TAP_MAX_DISTANCE) {
    return null;
  }
  return tap;
}

// Was a pointerup eligible to count as a tap? Caller chains two
// taps within DOUBLE_TAP_MAX_MS / DOUBLE_TAP_MAX_DISTANCE for a
// double-tap zoom toggle.
export function isTapRelease(
  tap: GestureState | null,
  pointer: Pointer & { time: number },
  activePointers: Pointer[],
): boolean {
  if (!tap || tap.kind !== 'tap-pending' || tap.pointerId !== pointer.pointerId) return false;
  if (activePointers.length !== 0) return false;
  if (pointer.time - tap.startTime >= TAP_MAX_MS) return false;
  if (Math.hypot(pointer.x - tap.startX, pointer.y - tap.startY) > TAP_MAX_DISTANCE) return false;
  return true;
}

// classifyDoubleTap decides whether a tap "now" should chain with
// the previous tap into a double-tap action. Used for zoom toggle.
export function classifyDoubleTap(
  prevTap: { time: number; x: number; y: number } | null,
  now: { time: number; x: number; y: number },
): boolean {
  if (!prevTap) return false;
  if (now.time - prevTap.time > DOUBLE_TAP_MAX_MS) return false;
  if (Math.hypot(now.x - prevTap.x, now.y - prevTap.y) > DOUBLE_TAP_MAX_DISTANCE) return false;
  return true;
}

// classifySwipe maps a swipe end-state into a high-level intent. The
// caller decides whether to apply it (`close` / next / prev) — we
// just compute the geometry. `pannableImage` blocks both navigation
// and close while the image is zoomed (the user is panning, not
// swiping).
export function classifySwipe(
  state: GestureState,
  endPointer: Pointer,
  pannableImage: boolean,
  navigatable: boolean,
): SwipeOutcome {
  if (state.kind !== 'swipe' || state.pointerId !== endPointer.pointerId) {
    return { kind: 'none', dx: 0, dy: 0 };
  }
  const dx = endPointer.x - state.startX;
  const dy = endPointer.y - state.startY;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (pannableImage) return { kind: 'none', dx, dy };
  if (absY >= SWIPE_MIN_DISTANCE && dy > 0 && absY > absX * SWIPE_AXIS_RATIO) {
    return { kind: 'close', dx, dy };
  }
  if (navigatable && absX >= SWIPE_MIN_DISTANCE && absX > absY * SWIPE_AXIS_RATIO) {
    return { kind: dx < 0 ? 'next' : 'prev', dx, dy };
  }
  return { kind: 'none', dx, dy };
}
