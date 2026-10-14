import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useDrag } from '@use-gesture/react';
import type { MotionValue } from 'motion/react';

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
// are pan-y (index.css). If the browser takes a touch over anyway (a native
// pan of a code block), the release is reported as aborted.

export interface AxisSwipeRelease {
  // Where the finger left the value, inside the range.
  value: number;
  // The finger's speed along the axis at release, px/s (signed).
  velocity: number;
  // The browser took the touch over mid-swipe; nothing was decided.
  aborted: boolean;
}

export interface AxisSwipeOptions {
  enabled: boolean;
  axis: 'x' | 'y';
  value: MotionValue<number>;
  range: () => readonly [number, number];
  // Whether a touch that starts on `target` may become this swipe.
  canStart: (target: EventTarget | null, surface: Element) => boolean;
  onStart?: () => void;
  onRelease: (release: AxisSwipeRelease) => void;
}

// How far the finger travels before the swipe decides its axis: past a
// finger's wobble, short of where the browser starts a native scroll.
const AXIS_LOCK_PX = 8;

export function useAxisSwipe({ enabled, axis, value, range, canStart, onStart, onRelease }: AxisSwipeOptions) {
  const i = axis === 'x' ? 0 : 1;
  // Where the value would be with the finger back at its starting point.
  const originRef = useRef(0);
  const bind = useDrag(
    ({ first, active, last, movement, velocity, direction, event }) => {
      if (first) {
        value.stop();
        originRef.current = value.get() - movement[i];
        onStart?.();
      }
      const [min, max] = range();
      const position = Math.min(max, Math.max(min, originRef.current + movement[i]));
      if (active) {
        value.set(position);
        return;
      }
      if (last) {
        onRelease({
          value: position,
          // use-gesture reports speed (px/ms) and direction separately.
          velocity: direction[i] * velocity[i] * 1000,
          aborted: event.type === 'pointercancel',
        });
      }
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
      if (canStart(event.target, event.currentTarget)) onPointerDown?.(event);
    },
  };
}
