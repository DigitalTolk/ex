import { describe, expect, it, vi } from 'vitest';
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
// The slot sonner gives the banner; it drops in from above.
const slot = () => banner()!.closest<HTMLElement>('[data-sonner-toast]')!;

async function show(onActivate = vi.fn()) {
  const screen = await render(<Toaster />);
  showToast('Can you look at this?', 'success', { title: 'Alice in ~general', kind: 'notification', group: 'ch-1:', onActivate });
  await expect.poll(() => banner()).not.toBeNull();
  // Where it rests, once it has dropped in.
  await expect.poll(() => slot().dataset.mounted === 'true' && slot().getAnimations().length === 0).toBe(true);
  return { screen, onActivate };
}

describe('swiping a notification banner away', () => {

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

  it('sits above every overlay, at the top, announced politely', async () => {
    await show();
    // The wide box: the banner fills its stack, up to max-w-md.
    expect(banner()!.offsetWidth).toBe(Math.min(448, window.innerWidth - 32));
    const stack = banner()!.closest<HTMLElement>('[data-sonner-toaster]')!;
    // Above the body-portalled popovers and typeahead (z-1000).
    expect(Number(getComputedStyle(stack).zIndex)).toBeGreaterThan(1000);
    expect(getComputedStyle(stack).position).toBe('fixed');
    expect(banner()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(banner()!.getBoundingClientRect().top).toBeLessThan(window.innerHeight / 4);
    expect(stack.closest('section')).toHaveAttribute('aria-live', 'polite');
  });

  // A finger swipes; a mouse has the X.
  it('shows the X only where there is a mouse', async () => {
    await show();
    const x = banner()!.querySelector('[aria-label="Dismiss"]')!;
    const touchOnly = document.documentElement.classList.contains('device-touch');
    expect(getComputedStyle(x).display === 'none').toBe(touchOnly);
  });
});

describe('plain toasts', () => {
  it('sit bottom-centre, hug their text and let taps beside them through', async () => {
    await render(
      <>
        <button type="button" data-testid="under" style={{ position: 'fixed', inset: 0 }}>
          under
        </button>
        <Toaster />
      </>,
    );
    showToast('Saved', 'success');
    await expect.poll(() => banner()).not.toBeNull();
    await expect.poll(() => slot().dataset.mounted === 'true' && slot().getAnimations().length === 0).toBe(true);
    const card = banner()!.getBoundingClientRect();
    expect(Math.abs(card.left + card.width / 2 - window.innerWidth / 2)).toBeLessThan(2);
    expect(card.bottom).toBeGreaterThan((window.innerHeight * 3) / 4);
    expect(card.width).toBeLessThan(slot().getBoundingClientRect().width / 2);
    const beside = document.elementFromPoint(slot().getBoundingClientRect().left + 4, card.top + card.height / 2);
    expect(beside).toBe(document.querySelector('[data-testid="under"]'));
  });
});
