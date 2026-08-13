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
  // Touch emulation stays ON afterwards — the chromium-mobile project's
  // Playwright context is itself touch-enabled, and flipping the override
  // off behind its back would strip that.
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  try {
    // Input synthesis targets the focused/foreground page; CI window
    // managers don't always grant that. Best-effort.
    await client.send('Page.bringToFront');
  } catch {
    // Page domain unavailable on this session — proceed.
  }
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
}

// Whether THIS environment's CDP input synthesis produces real compositor
// scrolling — probed once per test file against a plain overflow div with no
// app code involved. Chromium's headless shell on some CI hosts accepts
// synthesizeScrollGesture and scrolls nothing (observed 2026-08-12: green
// locally on macOS, scrollTop stuck at 0 on Linux CI). Callers skip the
// GESTURE assertions when the harness itself can't scroll — the structural
// assertions (scroll region containment, scrollability, drag-chrome
// attributes) must run unconditionally, since those are what pin the
// regression's shape.
let touchScrollCapability: boolean | null = null;

export async function touchScrollWorks(): Promise<boolean> {
  if (!canDriveNativeTouch()) return false;
  if (touchScrollCapability !== null) return touchScrollCapability;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:200px;height:200px;overflow-y:auto;z-index:2147483647;background:#fff';
  const filler = document.createElement('div');
  filler.style.height = '2000px';
  probe.appendChild(filler);
  // The synthesized gesture dispatches REAL pointer/touch events; swallow
  // them at the probe so app-level document listeners (e.g. a popover's
  // outside-pointerdown dismiss) never see the probe's input. Callers should
  // still probe BEFORE mounting the surface under test.
  for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'click']) {
    probe.addEventListener(type, (e) => e.stopPropagation());
  }
  document.body.appendChild(probe);
  try {
    await nativeTouchScroll(probe, { dy: -120 });
    touchScrollCapability = probe.scrollTop > 0;
  } catch {
    touchScrollCapability = false;
  } finally {
    probe.remove();
  }
  return touchScrollCapability;
}
