import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useDrag } from '@use-gesture/react';

// A sideways (or, for sheets, downward) swipe that moves `value` with the
// finger, 1:1, inside `range`, and reports the release. @use-gesture/react
// recognises the gesture: it waits until the finger has clearly gone along
// `axis` before taking it, so a scroll the other way stays native and a tap
// stays a tap. Taking it catches the surface where it is, mid-animation
// included (a sheet still sliding in, a panel springing back). The caller
// decides the release (lib/swipe) and animates it with Motion.
//
// The browser only leaves a move along `axis` to the page where touch-action
// rules out panning that way: an `x` surface and the vertical scrollers in it
// are pan-y (index.css). That decides who owns a touch only as it starts,
// though: iOS still turns a sideways drag that drifts up or down into a
// scroll of the list under it, which takes the touch from the swipe. So once
// the swipe has taken a touch, its moves are the swipe's — the scroll the
// browser would start from them is cancelled (holdTouch). Until then, and for
// a touch that goes the other way, scrolling stays native. If the browser
// takes a touch over anyway (a native pan of a code block), the release is
// reported as aborted.

export interface AxisSwipeRelease {
  // Where the finger left the value, inside the range.
  value: number;
  // The finger's speed along the axis at release, px/s (signed).
  velocity: number;
  // The browser took the touch over mid-swipe; nothing was decided.
  aborted: boolean;
}

// What a swipe moves: a Motion value, or anything read, set and stopped the
// same way (hooks/useSlide).
export interface SwipeValue {
  get(): number;
  set(value: number): void;
  // Ends any animation of the value, leaving it where it is.
  stop(): void;
}

export interface AxisSwipeOptions {
  enabled: boolean;
  axis: 'x' | 'y';
  value: SwipeValue;
  range: () => readonly [number, number];
  // Whether a touch that starts on `target` may become this swipe.
  canStart: (target: EventTarget | null, surface: Element) => boolean;
  onStart?: () => void;
  onRelease: (release: AxisSwipeRelease) => void;
}

// How far the finger travels before the swipe decides its axis: past a
// finger's wobble, short of where the browser starts a native scroll.
const AXIS_LOCK_PX = 8;

// holdTouch keeps the page from scrolling under a touch for as long as
// `taken()` says the swipe has it. It lets go when the last finger lifts (or
// when the returned stop is called), then calls `done`. A move is the browser's to scroll unless a touchmove
// listener cancels it, so this listens from the moment the finger lands
// (not from when the swipe takes the touch, which is too late for the
// browser to pick the listener up for this touch) and cancels only the
// moves that come after. use-gesture's own preventScroll also starts a drag
// on a press held still, which a scrolling list can't have.
function holdTouch(taken: () => boolean, done: () => void): () => void {
  const hold = (event: TouchEvent) => {
    if (taken() && event.cancelable) event.preventDefault();
  };
  const stop = () => {
    window.removeEventListener('touchmove', hold);
    window.removeEventListener('touchend', end);
    window.removeEventListener('touchcancel', end);
    done();
  };
  const end = (event: TouchEvent) => {
    if (event.touches.length === 0) stop();
  };
  window.addEventListener('touchmove', hold, { passive: false });
  window.addEventListener('touchend', end);
  window.addEventListener('touchcancel', end);
  return stop;
}

export function useAxisSwipe({ enabled, axis, value, range, canStart, onStart, onRelease }: AxisSwipeOptions) {
  const i = axis === 'x' ? 0 : 1;
  // Where the value would be with the finger back at its starting point.
  const originRef = useRef(0);
  // Whether this swipe has the current touch, and how to stop holding it.
  const takenRef = useRef(false);
  const stopHoldRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopHoldRef.current?.(), []);
  const bind = useDrag(
    ({ first, last, movement, velocity, direction, event }) => {
      if (first) {
        takenRef.current = true;
        value.stop();
        originRef.current = value.get() - movement[i];
        onStart?.();
      }
      const [min, max] = range();
      const position = Math.min(max, Math.max(min, originRef.current + movement[i]));
      // use-gesture calls this for each move of a taken gesture, then once
      // for the release.
      if (last) {
        takenRef.current = false;
        onRelease({
          value: position,
          // use-gesture reports speed (px/ms) and direction separately.
          velocity: direction[i] * velocity[i] * 1000,
          aborted: event.type === 'pointercancel',
        });
        return;
      }
      value.set(position);
    },
    {
      enabled,
      axis,
      axisThreshold: { mouse: AXIS_LOCK_PX, touch: AXIS_LOCK_PX, pen: AXIS_LOCK_PX },
      // The surface's children keep their own pointer targeting (long-press,
      // buttons); moves are followed on the window instead. No keyboard
      // moves: arrow keys belong to the content.
      pointer: { capture: false, keys: false },
    },
  );
  if (!enabled) return {};
  const { onPointerDown } = bind();
  return {
    onPointerDown: (event: ReactPointerEvent<Element>) => {
      if (!canStart(event.target, event.currentTarget)) return;
      if (event.pointerType === 'touch' && !stopHoldRef.current) {
        // A touch that ends without a release (the surface turned the swipe
        // off under it) must not leave the next one held.
        stopHoldRef.current = holdTouch(
          () => takenRef.current,
          () => {
            stopHoldRef.current = null;
            takenRef.current = false;
          },
        );
      }
      onPointerDown?.(event);
    },
  };
}
