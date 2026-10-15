import { afterEach, describe, expect, it } from 'vitest';
import { canDriveNativeTouch, nativeTouchScroll, nativeTouchSwipe } from './native-scroll';

const canHover = () => matchMedia('(hover: hover)').matches;

let surface: HTMLElement | null = null;
afterEach(() => {
  surface?.remove();
  surface = null;
});

// Regression: the gestures used to leave CDP touch emulation on, so every
// test file that ran after one in the same browser saw `(hover: none)` and
// Tailwind's `hover:` styles never applied — the desktop real-hover tests
// failed or passed depending on file order.
describe('native touch gestures', () => {
  it('leave the page able to hover', async () => {
    if (!canDriveNativeTouch()) return;
    expect(canHover()).toBe(true);
    surface = document.createElement('div');
    surface.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;overflow-y:auto';
    surface.appendChild(Object.assign(document.createElement('div'), { style: 'height:2000px' }));
    document.body.appendChild(surface);

    await nativeTouchSwipe(surface, { dx: 40, steps: 2, stepMs: 1 });
    expect(canHover()).toBe(true);
    await nativeTouchScroll(surface, { dy: -60 });
    expect(canHover()).toBe(true);
    expect(navigator.maxTouchPoints).toBe(0);
  });
});
