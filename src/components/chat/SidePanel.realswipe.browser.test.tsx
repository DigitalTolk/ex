import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from 'vitest-browser-react';
import { SidePanel } from './SidePanel';
import { swipe } from '@/test/gestures';

// REAL-surface proof for the shared right-rail shell: SidePanel spreads the
// REAL useSwipeDismiss('right', onClose) motionProps onto its <motion.aside>.
// A genuine rightward finger drag past the threshold must animate the panel
// off-screen and fire onClose; a small below-threshold drag must spring back
// and leave it open. Every other SidePanel test mocks useSwipeDismiss — this
// one drives Motion's real drag engine via swipe().

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
});
