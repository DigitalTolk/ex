import { expect } from 'vitest';

// The on-screen keyboard for browser tests. Playwright can't raise a real
// one, so it is reported the way the Capacitor shell reports it. Mount
// KeyboardInsetTracker (./KeyboardInsetTracker) for the app to follow it.

export function fireKeyboard(name: 'keyboardWillShow' | 'keyboardWillHide', height = 0) {
  window.dispatchEvent(Object.assign(new CustomEvent(name), { keyboardHeight: height }));
}

// Resolves once the app has caught up with the keyboard: `arrived` (where the
// keyboard puts what the test looks at) holds and nothing on the page is
// still sliding into place. Never a fixed wait: a surface easing along with
// the keyboard (KEYBOARD_SETTLE_MS) starts moving only when the browser next
// renders, which a busy runner can put off, and a 400ms sleep then measured
// it halfway.
export async function keyboardSettled(arrived: () => boolean) {
  await expect.poll(() => ({ arrived: arrived(), sliding: sliding() })).toEqual({ arrived: true, sliding: 0 });
}

// How many transitions or finite animations are still running. Reading them
// applies pending style changes first, so a slide the last render set off
// counts before its first frame. An endless animation (a loading pulse) never
// settles and is no slide.
function sliding(): number {
  return document
    .getAnimations()
    .filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().endTime !== Infinity).length;
}
