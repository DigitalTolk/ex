import { act } from 'react';

// Real pointer-gesture driver for the browser (Playwright) test suite.
//
// Motion's drag gesture (motion/react → framer-motion) is pointer-event based:
//   • `pointerdown` is listened for on the ELEMENT (VisualElementDragControls.addListeners).
//   • Once down, a PanSession attaches `pointermove` / `pointerup` / `pointercancel`
//     on the CONTEXT WINDOW (not the element) — so moves/up must be dispatched on `window`.
//   • The pan reads coordinates from `event.pageX` / `event.pageY` (event-info.mjs),
//     NOT clientX/clientY — so we pin pageX/pageY on every synthetic event.
//   • `isPrimaryPointer` must hold: for touch/pen `isPrimary !== false`; for mouse `button <= 0`.
//   • A pan only STARTS once the offset from the down-point exceeds 3px (distanceThreshold),
//     and with `dragDirectionLock` the first past-10px move only LOCKS the axis, so several
//     moves are needed before the axis value actually tracks the finger.
//   • Velocity is derived from a timestamped history whose timestamps come from Motion's
//     frame clock — so moves must be spread across frames (we await rAF + a delay per step)
//     for a non-zero, realistic velocity. A trailing "settle" (a delayed no-move sample)
//     drives velocity back to ~0 to exercise the below-threshold spring-back path.
//
// Everything is wrapped in React's `act()` so the state updates Motion drives
// (onDragStart/onDrag/onDragEnd → setState) are flushed and warning-free.

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
  // Motion reads pageX/pageY (not clientX/clientY). These are read-only derived
  // properties on a constructed event and are unreliable across engines, so we
  // pin them explicitly to guarantee the pan sees the coordinates we intend.
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
  /** Delay (ms) between samples — spreads them across Motion frames so velocity is real. */
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
}

/**
 * Drive a REAL Motion drag by dispatching a native pointer sequence:
 * pointerdown on `el`, N pointermoves on `window`, pointerup on `window`.
 * Returns after Motion's post-render onDragEnd has had a chance to run.
 */
export async function swipe(el: Element, opts: SwipeOptions = {}): Promise<void> {
  const { dx = 0, dy = 0, steps = 6, stepMs = 24, from, settle = false } = opts;
  const rect = el.getBoundingClientRect();
  const startX = from?.x ?? rect.left + rect.width / 2;
  const startY = from?.y ?? rect.top + rect.height / 2;
  const pointerId = nextPointerId++;

  await withAct(async () => {
    // Press on the element — this is what arms the PanSession.
    el.dispatchEvent(pointerEvent('pointerdown', startX, startY, pointerId));
    await raf();

    // Walk toward the target, one sample per frame, so Motion's frame clock
    // advances between samples and builds a velocity history.
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
      // Let the recent movement age out of the 100ms velocity window, then take
      // one more sample at the SAME point → release velocity computes to ~0.
      await sleep(140);
      await raf();
      window.dispatchEvent(pointerEvent('pointermove', endX, endY, pointerId));
      await raf();
    }

    window.dispatchEvent(pointerEvent('pointerup', endX, endY, pointerId));
    // onDragEnd is scheduled via frame.postRender — wait a couple frames for it.
    await raf();
    await raf();
  });
}
