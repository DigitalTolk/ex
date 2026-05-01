import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { forwardRef, useImperativeHandle, useRef } from 'react';
import { useStickToBottomOnSettle } from './useStickToBottomOnSettle';

// Test harness: a tiny component that drives the hook against
// real DOM elements. Each test mocks `scrollHeight` so we can
// assert exact `scrollTop` values without needing real layout.
// Imperative access goes through useImperativeHandle so the
// harness owns its state without the test mutating props directly.
interface HarnessHandle {
  done: () => boolean;
  setAtBottom: (v: boolean) => void;
  scroller: () => HTMLDivElement | null;
  inner: () => HTMLDivElement | null;
}

interface HarnessProps {
  pulse: number;
  disabled?: boolean;
  initialAtBottom?: boolean;
}

const Harness = forwardRef<HarnessHandle, HarnessProps>(function Harness(
  { pulse, disabled = false, initialAtBottom = true },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef(false);
  const atBottomRef = useRef(initialAtBottom);
  useImperativeHandle(ref, () => ({
    done: () => doneRef.current,
    setAtBottom: (v: boolean) => { atBottomRef.current = v; },
    scroller: () => scrollRef.current,
    inner: () => innerRef.current,
  }), []);
  useStickToBottomOnSettle({
    scrollRef,
    innerRef,
    pulse,
    doneRef,
    atBottomRef,
    disabled,
  });
  return (
    <div ref={scrollRef} data-testid="scroller">
      <div ref={innerRef}>content</div>
    </div>
  );
});

function setHeight(el: HTMLElement, value: number) {
  Object.defineProperty(el, 'scrollHeight', { value, configurable: true });
}

describe('useStickToBottomOnSettle', () => {
  let rafCallbacks: Array<() => void>;
  let originalRAF: typeof requestAnimationFrame;

  beforeEach(() => {
    // Synchronous-on-demand rAF: tests advance the chase by calling
    // `flushFrames(n)` rather than relying on real timers. This makes
    // the settle loop deterministic without yielding control to the
    // event loop between assertions.
    rafCallbacks = [];
    originalRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafCallbacks.push(() => cb(0));
      return rafCallbacks.length;
    }) as typeof requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRAF;
  });

  function flushFrames(n: number) {
    for (let i = 0; i < n; i++) {
      const next = rafCallbacks.shift();
      if (!next) return;
      next();
    }
  }

  function createHandleRef() {
    return { current: null as HarnessHandle | null };
  }

  it('synchronously sticks scrollTop to scrollHeight on first run', () => {
    const h = createHandleRef();
    render(<Harness ref={h} pulse={1} />);
    const scroller = h.current!.scroller()!;
    setHeight(scroller, 1500);
    // The synchronous stick already ran during the layout effect on
    // initial render. Verify the dedup gate flipped.
    expect(h.current!.done()).toBe(true);
  });

  it('skips when disabled (deep-link mode)', () => {
    const h = createHandleRef();
    render(<Harness ref={h} pulse={1} disabled={true} />);
    expect(h.current!.done()).toBe(false); // never ran
  });

  it('skips when pulse is 0 (no messages yet)', () => {
    const h = createHandleRef();
    render(<Harness ref={h} pulse={0} />);
    expect(h.current!.done()).toBe(false);
  });

  it('continues re-sticking across frames as scrollHeight grows', () => {
    const h = createHandleRef();
    render(<Harness ref={h} pulse={1} />);
    const scroller = h.current!.scroller()!;
    setHeight(scroller, 1000);
    flushFrames(1);
    expect(scroller.scrollTop).toBe(1000);
    // Image decodes, content grows.
    setHeight(scroller, 1300);
    flushFrames(1);
    expect(scroller.scrollTop).toBe(1300);
    // Another reflow.
    setHeight(scroller, 1700);
    flushFrames(1);
    expect(scroller.scrollTop).toBe(1700);
  });

  it('terminates after STABILITY_FRAMES of unchanged scrollHeight', () => {
    const h = createHandleRef();
    render(<Harness ref={h} pulse={1} />);
    const scroller = h.current!.scroller()!;
    setHeight(scroller, 1000);
    // 5 frames at the same height — STABILITY_FRAMES — should stop
    // queuing further rAFs. Drain the queue to see how many fired.
    for (let i = 0; i < 10; i++) flushFrames(1);
    // After stabilization, no more rAF callbacks pending.
    expect(rafCallbacks.length).toBe(0);
  });

  it('stops the chase when isAtBottom flips false (user scrolled up)', () => {
    const h = createHandleRef();
    render(<Harness ref={h} pulse={1} />);
    const scroller = h.current!.scroller()!;
    setHeight(scroller, 1000);
    flushFrames(1);
    expect(scroller.scrollTop).toBe(1000);
    // User scrolls up, then content grows — chase must NOT yank.
    h.current!.setAtBottom(false);
    scroller.scrollTop = 200;
    setHeight(scroller, 2000);
    flushFrames(2);
    expect(scroller.scrollTop).toBe(200);
  });

  it('cleanup cancels the chase so a stale rAF does not write after unmount', () => {
    const h = createHandleRef();
    const { unmount } = render(<Harness ref={h} pulse={1} />);
    const scroller = h.current!.scroller()!;
    setHeight(scroller, 1000);
    flushFrames(1);
    unmount();
    // After unmount, more frames pending in the queue should be no-ops.
    setHeight(scroller, 9999);
    for (let i = 0; i < 10; i++) flushFrames(1);
    expect(scroller.scrollTop).toBe(1000); // unchanged after unmount
  });

  it('re-sticks across frames when scrollHeight grows from late image decode', () => {
    const h = createHandleRef();
    render(<Harness ref={h} pulse={1} />);
    const scroller = h.current!.scroller()!;
    const inner = h.current!.inner()!;
    // Inject a non-complete <img> into the inner container so the
    // hook's per-image load listeners are attached. The hook's
    // querySelectorAll runs on mount BEFORE this injection — this
    // test exercises the rAF chase covering subsequent height
    // changes from late image decoding regardless.
    const img = document.createElement('img');
    Object.defineProperty(img, 'complete', { value: false, configurable: true });
    inner.appendChild(img);
    setHeight(scroller, 800);
    flushFrames(1);
    expect(scroller.scrollTop).toBe(800);
    setHeight(scroller, 1100);
    flushFrames(1);
    expect(scroller.scrollTop).toBe(1100);
  });

  it('runs document.fonts.ready re-stick after fonts settle', async () => {
    const origFonts = (document as unknown as { fonts?: { ready: Promise<void> } }).fonts;
    let resolveFonts!: () => void;
    const ready = new Promise<void>((r) => { resolveFonts = r; });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready },
    });
    try {
      const h = createHandleRef();
      render(<Harness ref={h} pulse={1} />);
      const scroller = h.current!.scroller()!;
      setHeight(scroller, 1000);
      // Web fonts settle — text reflowed, content grew.
      setHeight(scroller, 1400);
      resolveFonts();
      // Microtask flush so the .then callback runs.
      await Promise.resolve();
      await Promise.resolve();
      expect(scroller.scrollTop).toBe(1400);
    } finally {
      Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: origFonts,
      });
    }
  });
});
