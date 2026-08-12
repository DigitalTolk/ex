import { cdp, server } from 'vitest/browser';

// REAL, browser-driven touch scrolling for the browser suite.
//
// Why this exists: `swipe()` in gestures.ts dispatches a synthetic
// PointerEvent sequence, which is exactly right for driving Motion's JS drag
// engine — and structurally incapable of proving the other half of a mobile
// sheet's behaviour. A dispatched event never makes a browser SCROLL; only
// genuine input does, and only after the compositor has consulted
// `touch-action` on every ancestor of the touched node. So a gesture that a
// JS handler quietly swallows looks identical, in a synthetic test, to one the
// browser happily turns into a native pan.
//
// That blind spot is why "the emoji picker won't scroll on mobile" survived a
// green suite that had a dedicated regression test for it: the test proved the
// sheet was not DISMISSED by a drag over the grid, never that anything moved.
//
// Chromium only — this goes through CDP's input synthesis, which is what
// produces a true compositor-level gesture. Guard calls with
// `canDriveNativeTouch()`; the webkit-iphone project still runs the file's
// DOM/geometry assertions, it just skips the gesture itself.

export function canDriveNativeTouch(): boolean {
  return server.browser === 'chromium';
}

// vitest declares CDPSession as an opaque empty interface (each provider
// augments it), so state the one method we use structurally.
interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

// The tester iframe is CSS-scaled to fit the real browser window (a 390x844
// "viewport" is painted into a ~333x720 box), so in-frame CSS pixels are not
// top-level page pixels. CDP speaks page pixels.
function toPagePoint(x: number, y: number) {
  const frame = window.frameElement as HTMLElement | null;
  /* v8 ignore next 2 -- the browser suite always runs inside the tester iframe; the standalone-window arm is defensive */
  /* istanbul ignore next -- the browser suite always runs inside the tester iframe; the standalone-window arm is defensive */
  if (!frame) return { x, y, scale: 1 };
  const rect = frame.getBoundingClientRect();
  const scale = rect.width / window.innerWidth;
  return { x: rect.left + x * scale, y: rect.top + y * scale, scale };
}

export interface NativeScrollOptions {
  /** Finger travel in px. Negative scrolls the content UP (reveals what is below). */
  dy: number;
  /** Gesture origin in viewport coordinates. Defaults to the element's centre. */
  from?: { x: number; y: number };
}

/**
 * Drive a genuine touch pan starting on `el` and let it settle.
 *
 * Whether anything scrolls is the browser's decision, exactly as on a phone —
 * which is the entire point: assert on the resulting `scrollTop`.
 */
export async function nativeTouchScroll(el: Element, { dy, from }: NativeScrollOptions): Promise<void> {
  const client = cdp() as unknown as CdpClient;
  const rect = el.getBoundingClientRect();
  const origin = from ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  const point = toPagePoint(origin.x, origin.y);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    await client.send('Input.synthesizeScrollGesture', {
      x: Math.round(point.x),
      y: Math.round(point.y),
      xDistance: 0,
      yDistance: Math.round(dy * point.scale),
      gestureSourceType: 'touch',
      speed: 800,
    });
    // Let momentum/settling finish before the caller reads scrollTop.
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  }
}
