import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { SidePanel } from './SidePanel';
import { swipe } from '@/test/gestures';
import { nativeTouchSwipe, touchScrollWorks } from '@/test/native-scroll';

// REAL-surface proof for the shared right-rail shell: SidePanel spreads the
// REAL useSwipeDismiss('right', onClose) motionProps onto its <motion.aside>.
// A genuine rightward finger drag past the threshold must animate the panel
// off-screen and fire onClose; a small below-threshold drag must spring back
// and leave it open. Every other SidePanel test mocks useSwipeDismiss — this
// one drives the real gesture via swipe(), and a real finger (CDP) over the
// panel's scrolling body.

afterEach(() => cleanup());

const aside = () => document.querySelector('aside[aria-label="My panel"]') as HTMLElement | null;

async function renderPanel(onClose = vi.fn()) {
  await render(
    <SidePanel title="My Panel" ariaLabel="My panel" closeLabel="Close my panel" onClose={onClose}>
      <p>panel body</p>
    </SidePanel>,
  );
  return onClose;
}

describe('SidePanel — real swipe-to-dismiss', () => {
  it('a RIGHT swipe past the threshold closes the panel', async () => {
    if (window.innerWidth > 767) return; // drag only arms on mobile
    const onClose = await renderPanel();
    const el = aside();
    expect(el).not.toBeNull();

    // A real rightward drag well past DISMISS_DISTANCE (72px).
    await swipe(el!, { dx: 220, steps: 8, stepMs: 18 });

    // onClose fires once the exit spring completes.
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('a small RIGHT swipe below the threshold springs back and stays open', async () => {
    if (window.innerWidth > 767) return;
    const onClose = await renderPanel();
    const el = aside();
    expect(el).not.toBeNull();

    // 40px (< 72px) released slowly (settle → ~0 velocity): neither distance
    // nor velocity threshold met, so the panel must NOT close.
    await swipe(el!, { dx: 40, steps: 5, stepMs: 24, settle: true });

    await new Promise((r) => setTimeout(r, 60));
    expect(onClose).not.toHaveBeenCalled();
    expect(aside()).not.toBeNull();
  });

  // A slow sideways swipe over the panel's own scrolling body used to be
  // claimed by the browser as a pan of that body a few pixels in.
  it('a SLOW right swipe over the scrolling body closes the panel (real finger)', async () => {
    if (window.innerWidth > 767) return;
    const canDrive = await touchScrollWorks();
    const onClose = vi.fn();
    await render(
      <SidePanel title="My Panel" ariaLabel="My panel" closeLabel="Close my panel" onClose={onClose}>
        <div style={{ height: 3000 }}>long panel body</div>
      </SidePanel>,
    );
    const body = aside()!.querySelector('.overflow-y-auto') as HTMLElement;
    expect(getComputedStyle(body).touchAction).toBe('pan-y');
    if (!canDrive) return;
    // Let the slide-in finish so the finger lands on a panel at rest.
    await new Promise((r) => setTimeout(r, 500));

    const { left, top } = body.getBoundingClientRect();
    await nativeTouchSwipe(body, { from: { x: left + 40, y: top + 120 }, dx: 220, steps: 25, stepMs: 30 });

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 5000 });
  });
});
