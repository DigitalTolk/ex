import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { motion } from 'motion/react';
import { swipe } from '@/test/gestures';
import { useSwipeDismiss } from './useSwipeDismiss';

// REAL swipe coverage for the dismiss gesture. Unlike useSwipeDismiss.test.ts
// and the component browser tests (which mock this hook wholesale), this file
// drives ACTUAL native PointerEvents through @use-gesture/react via the
// `swipe()` helper and asserts the releases that go through (lib/swipe) do,
// and the ones that don't spring back. This is the wiring nothing else
// verifies: that the motionProps returned by the hook, spread onto a real
// motion element, turn a genuine finger drag into a dismiss.

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
// At rest: the slide-in (or a spring back) has finished.
const atRest = () => {
  const t = getComputedStyle(sheet()).transform;
  return t === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(t);
};
async function renderSettled(direction: 'right' | 'down', onDismiss: () => void) {
  await render(<Harness direction={direction} onDismiss={onDismiss} />);
  await vi.waitFor(() => expect(atRest()).toBe(true));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSwipeDismiss real swipe', () => {
  it('a DOWN swipe past the commit distance dismisses', async () => {
    const onDismiss = vi.fn();
    await renderSettled('down', onDismiss);

    await swipe(sheet(), { dy: 200, steps: 8, stepMs: 20 });

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('a small DOWN swipe released at rest springs back and does NOT dismiss', async () => {
    const onDismiss = vi.fn();
    await renderSettled('down', onDismiss);

    // 40px down released slowly (settle → ~0 velocity): short of the commit
    // distance, so the sheet springs back.
    await swipe(sheet(), { dy: 40, steps: 5, stepMs: 24, settle: true });

    await vi.waitFor(() => expect(atRest()).toBe(true));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // The reported bug: only a quick flick dismissed; a slow, deliberate drag
  // sprang back. Distance alone carries a slow release through.
  it('a SLOW right swipe that comes to rest past the commit distance dismisses', async () => {
    const onDismiss = vi.fn();
    await renderSettled('right', onDismiss);

    await swipe(sheet(), { dx: 200, steps: 20, stepMs: 40, settle: true });

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  // The browser took the touch over (a native pan): nothing was decided, so
  // even a long swipe goes back.
  it('springs back when the browser cancels the touch mid-swipe', async () => {
    const onDismiss = vi.fn();
    await renderSettled('right', onDismiss);

    await swipe(sheet(), { dx: 200, steps: 8, stepMs: 20, cancel: true });

    await vi.waitFor(() => expect(atRest()).toBe(true));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  // A finger that lands while the panel is still sliding in catches it where
  // it is and pulls it the rest of the way (no further than its resting
  // place); let go there, it stays.
  it('catches a panel mid-slide-in and pulls it in', async () => {
    const onDismiss = vi.fn();
    await render(<Harness direction="right" onDismiss={onDismiss} />);
    await nextFrame();

    await swipe(sheet(), { dx: -400, steps: 8, stepMs: 20, settle: true });

    await vi.waitFor(() => expect(atRest()).toBe(true));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
