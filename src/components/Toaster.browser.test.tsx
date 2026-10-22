import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Toaster } from './Toaster';
import { showToast } from '@/lib/toast';

// A notification banner goes away with a swipe, up or to either side, the
// way a phone's own banners do; a short drag puts it back. A tap still opens
// the message.

const raf = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
let pointerId = 500;

function pointer(type: string, x: number, y: number, id: number) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: id,
    isPrimary: true,
    pointerType: 'touch',
    button: type === 'pointerdown' ? 0 : -1,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

async function drag(el: Element, dx: number, dy: number, steps = 6) {
  const box = el.getBoundingClientRect();
  const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const id = pointerId++;
  el.dispatchEvent(pointer('pointerdown', from.x, from.y, id));
  for (let i = 1; i <= steps; i++) {
    window.dispatchEvent(pointer('pointermove', from.x + (dx * i) / steps, from.y + (dy * i) / steps, id));
    await raf();
  }
  window.dispatchEvent(pointer('pointerup', from.x + dx, from.y + dy, id));
}

const banner = () => document.querySelector<HTMLElement>('[data-testid="toast"]');

async function show(onActivate = vi.fn()) {
  const screen = await render(<Toaster />);
  showToast('Can you look at this?', 'success', { title: 'Alice in ~general', kind: 'notification', group: 'ch-1:', onActivate });
  await expect.poll(() => banner()).not.toBeNull();
  return { screen, onActivate };
}

describe('swiping a notification banner away', () => {
  afterEach(() => document.body.querySelectorAll('[data-testid="toast"]').forEach((el) => el.remove()));

  it.each([
    ['up', 0, -120],
    ['to the left', -260, 0],
    ['to the right', 260, 0],
  ])('goes away when swiped %s, opening nothing', async (_name, dx, dy) => {
    const { onActivate } = await show();
    await drag(banner()!, dx, dy);
    await expect.poll(() => banner(), { timeout: 3000 }).toBeNull();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('comes back from a short drag up', async () => {
    await show();
    const top = banner()!.getBoundingClientRect().top;
    await drag(banner()!, 0, -12, 10);
    await expect.poll(() => Math.abs(banner()!.getBoundingClientRect().top - top)).toBeLessThan(2);
  });

  it('comes back from a short drag', async () => {
    const { onActivate } = await show();
    await drag(banner()!, 30, 0, 10);
    await expect.poll(() => Math.abs(banner()!.getBoundingClientRect().left - (window.innerWidth - banner()!.offsetWidth) / 2)).toBeLessThan(2);
    expect(banner()).not.toBeNull();
    // The drag's own click opens nothing.
    banner()!.querySelector<HTMLElement>('[data-testid="toast-open"]')!.click();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('opens the message on a tap', async () => {
    const { onActivate } = await show();
    const open = banner()!.querySelector<HTMLElement>('[data-testid="toast-open"]')!;
    const box = open.getBoundingClientRect();
    const id = pointerId++;
    open.dispatchEvent(pointer('pointerdown', box.left + 10, box.top + 10, id));
    window.dispatchEvent(pointer('pointerup', box.left + 10, box.top + 10, id));
    open.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
    await expect.poll(() => banner()).toBeNull();
  });

  // A finger swipes; a mouse has the X.
  it('shows the X only where there is a mouse', async () => {
    await show();
    const x = banner()!.querySelector('[aria-label="Dismiss"]')!;
    const touchOnly = document.documentElement.classList.contains('device-touch');
    expect(getComputedStyle(x).display === 'none').toBe(touchOnly);
  });
});
