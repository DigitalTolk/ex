import { afterEach, describe, expect, it } from 'vitest';
import { canDriveNativeTouch, nativeTouchScroll, nativeTouchSwipe } from './native-scroll';

const canHover = () => matchMedia('(hover: hover)').matches;

let surface: HTMLElement | null = null;
afterEach(() => {
  surface?.remove();
  surface = null;
});

// Regression: the gestures turned on CDP touch emulation, which leaves the
// page reporting `(hover: none)` — for good on Linux, where turning it off
// does not restore hover — so Tailwind's `hover:` styles never applied in any
// test file that ran after one in the same browser, and the real-hover tests
// failed or passed depending on file order.
describe('native touch gestures', () => {
  it('leave the page able to hover', async () => {
    if (!canDriveNativeTouch()) return;
    expect(canHover()).toBe(true);
    surface = document.createElement('div');
    surface.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;overflow-y:auto';
    surface.appendChild(Object.assign(document.createElement('div'), { style: 'height:2000px' }));
    document.body.appendChild(surface);

    const touches: string[] = [];
    surface.addEventListener('pointerdown', (e) => touches.push(e.pointerType));
    await nativeTouchSwipe(surface, { dx: 40, steps: 2, stepMs: 1 });
    // Still a finger, as far as the page can tell…
    expect(touches).toEqual(['touch']);
    // …without the page ever being told it has no mouse.
    expect(canHover()).toBe(true);
    await nativeTouchScroll(surface, { dy: -60 });
    expect(canHover()).toBe(true);
    expect(navigator.maxTouchPoints).toBe(0);
  });
});
