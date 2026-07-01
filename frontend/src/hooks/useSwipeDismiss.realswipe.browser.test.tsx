import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { motion } from 'motion/react';
import { swipe } from '@/test/gestures';
import { useSwipeDismiss } from './useSwipeDismiss';

// REAL swipe coverage for the Motion-powered dismiss gesture. Unlike
// useSwipeDismiss.test.ts (which fabricates a PanInfo and hand-calls onDragEnd)
// and the component browser tests (which mock this hook wholesale), this file
// drives ACTUAL native PointerEvents through Motion's drag engine via the
// `swipe()` helper and asserts the real distance/velocity thresholds fire (or
// don't) onDismiss. This is the wiring nothing else verifies: that the
// motionProps returned by the hook, spread onto a real motion element, turn a
// genuine finger drag into a dismiss.

// The hook only arms drag on mobile.
vi.mock('./useIsMobile', () => ({ useIsMobile: () => true }));

function Harness({
  direction,
  onDismiss,
}: {
  direction: 'right' | 'down';
  onDismiss: () => void;
}) {
  const { motionProps, dismissing } = useSwipeDismiss(direction, onDismiss);
  return (
    <motion.div
      {...motionProps}
      data-testid="sheet"
      data-dismissing={dismissing}
      style={{
        ...(motionProps as { style?: object }).style,
        position: 'fixed',
        left: 40,
        top: 120,
        width: 300,
        height: 320,
        background: '#222',
      }}
    >
      swipe me
    </motion.div>
  );
}

const sheet = () => document.querySelector('[data-testid="sheet"]') as HTMLElement;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSwipeDismiss real swipe (drives Motion drag)', () => {
  it('a DOWN swipe past the distance threshold dismisses', async () => {
    const onDismiss = vi.fn();
    await render(<Harness direction="down" onDismiss={onDismiss} />);
    await nextFrame();

    // 160px down, comfortably past DISMISS_DISTANCE (72px).
    await swipe(sheet(), { dy: 160, steps: 8, stepMs: 20 });

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('a small DOWN swipe below the threshold springs back and does NOT dismiss', async () => {
    const onDismiss = vi.fn();
    await render(<Harness direction="down" onDismiss={onDismiss} />);
    await nextFrame();

    // 40px down (< 72px) released slowly (settle → ~0 velocity) so neither the
    // distance nor the velocity threshold is met: the sheet must spring back.
    await swipe(sheet(), { dy: 40, steps: 5, stepMs: 24, settle: true });

    await nextFrame();
    expect(onDismiss).not.toHaveBeenCalled();
    // Springs back to rest: the y transform returns to ~0.
    await vi.waitFor(() => {
      const t = getComputedStyle(sheet()).transform;
      expect(t === 'none' || /matrix\([^)]*\b0\)/.test(t)).toBe(true);
    });
  });

  it('a fast DOWN flick past the velocity threshold dismisses even over a short distance', async () => {
    const onDismiss = vi.fn();
    await render(<Harness direction="down" onDismiss={onDismiss} />);
    await nextFrame();

    // Short (60px < 72px distance) but FAST: no settle, tight steps → the
    // release velocity exceeds DISMISS_VELOCITY (400px/s) and dismisses.
    await swipe(sheet(), { dy: 60, steps: 4, stepMs: 8 });

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('a RIGHT swipe past the distance threshold dismisses on the horizontal variant', async () => {
    const onDismiss = vi.fn();
    await render(<Harness direction="right" onDismiss={onDismiss} />);
    await nextFrame();

    await swipe(sheet(), { dx: 180, steps: 8, stepMs: 20 });

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });
});
