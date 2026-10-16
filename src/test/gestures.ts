import { act } from 'react';

// Real pointer-gesture driver for the browser (Playwright) test suite.
//
// The app's swipes are recognised by @use-gesture/react (hooks/useAxisSwipe):
//   • `pointerdown` is listened for on the ELEMENT (React's onPointerDown).
//   • Once down, moves and the release are followed on the WINDOW (pointer
//     capture is off), so moves/up must be dispatched on `window`.
//   • Coordinates come from clientX/clientY; pageX/pageY are pinned too for
//     anything else reading them.
//   • The swipe only claims a gesture once it has gone clearly along its axis
//     (8px), so several moves are needed before the surface follows.
//   • Velocity comes from the event timestamps, so moves are spread across
//     frames (we await rAF + a delay per step). A trailing "settle" (a delayed
//     no-move sample) brings the release velocity back to ~0, for a slow
//     deliberate release.
//
// Everything is wrapped in React's `act()` so the state updates the release
// drives are flushed and warning-free.

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// React's `act` requires IS_REACT_ACT_ENVIRONMENT to be true, but the browser
// suite otherwise leaves it false (so vitest-browser-react's own render/userEvent
// don't demand act wrapping). Mirror MessageList.browser.test.tsx: flip the flag
// on only for the duration of our manual act, so the Motion-driven state updates
// are act-scoped and warning-free, then restore it.
async function withAct(callback: () => Promise<void>): Promise<void> {
  const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = g.IS_REACT_ACT_ENVIRONMENT;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      await callback();
    });
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = prev;
  }
}

let nextPointerId = 1;

function pointerEvent(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  pointerId: number,
): PointerEvent {
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId,
    isPrimary: true,
    pointerType: 'touch',
    // pointerdown carries the primary button; move/up report no buttons held
    // in a way isPrimaryPointer is happy with for touch (button is ignored there).
    button: type === 'pointerdown' ? 0 : -1,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    clientX: x,
    clientY: y,
    width: 1,
    height: 1,
  });
  // pageX/pageY are read-only derived properties on a constructed event and
  // unreliable across engines, so pin them to the coordinates we intend.
  Object.defineProperty(ev, 'pageX', { get: () => x });
  Object.defineProperty(ev, 'pageY', { get: () => y });
  return ev;
}

export interface SwipeOptions {
  /** Horizontal travel in px (positive = right). */
  dx?: number;
  /** Vertical travel in px (positive = down). */
  dy?: number;
  /** Number of intermediate pointermove samples. More steps = smoother/faster velocity. */
  steps?: number;
  /** Delay (ms) between samples — spreads them across frames so velocity is real. */
  stepMs?: number;
  /** Origin of the gesture; defaults to the element's center. */
  from?: { x: number; y: number };
  /**
   * If true, end the gesture "slowly": wait, then take one final no-move sample
   * so the computed release velocity decays to ~0. Use this to exercise the
   * below-threshold spring-back path deterministically (a fast flick would
   * otherwise trip the velocity threshold even for a short distance).
   */
  settle?: boolean;
  /**
   * End with a pointercancel instead of a pointerup: the browser took the
   * touch over (a native pan) before the finger lifted.
   */
  cancel?: boolean;
}

/**
 * Drive a REAL swipe by dispatching a native pointer sequence: pointerdown on
 * `el`, N pointermoves on `window`, pointerup (or pointercancel) on `window`.
 * Returns once the release has been handled.
 */
export async function swipe(el: Element, opts: SwipeOptions = {}): Promise<void> {
  const { dx = 0, dy = 0, steps = 6, stepMs = 24, from, settle = false, cancel = false } = opts;
  const rect = el.getBoundingClientRect();
  const startX = from?.x ?? rect.left + rect.width / 2;
  const startY = from?.y ?? rect.top + rect.height / 2;
  const pointerId = nextPointerId++;

  await withAct(async () => {
    // Press on the element — this is what arms the swipe.
    el.dispatchEvent(pointerEvent('pointerdown', startX, startY, pointerId));
    await raf();

    // Walk toward the target, one sample per frame, so the samples carry a
    // real velocity.
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = startX + dx * t;
      const y = startY + dy * t;
      window.dispatchEvent(pointerEvent('pointermove', x, y, pointerId));
      await sleep(stepMs);
      await raf();
    }

    const endX = startX + dx;
    const endY = startY + dy;

    if (settle) {
      // Pause, then take one more sample at the SAME point → the release
      // velocity computes to ~0.
      await sleep(140);
      await raf();
      window.dispatchEvent(pointerEvent('pointermove', endX, endY, pointerId));
      await raf();
    }

    window.dispatchEvent(pointerEvent(cancel ? 'pointercancel' : 'pointerup', endX, endY, pointerId));
    // Let the release's state updates and first animation frame land.
    await raf();
    await raf();
  });
}
