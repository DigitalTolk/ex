import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSwipeDismiss } from './useSwipeDismiss';
import type { AxisSwipeOptions, AxisSwipeRelease } from './useAxisSwipe';

const mobileRef = { value: true };
vi.mock('./useIsMobile', () => ({ useIsMobile: () => mobileRef.value }));

// The gesture itself (a finger recognised by @use-gesture/react) is driven
// for real in useSwipeDismiss.realswipe.browser.test; here the hook's own
// decisions are checked against the options it hands the gesture: where a
// swipe may start, and what each release does. The enter/exit animations
// run the real Motion engine.
const swipeRef = vi.hoisted(() => ({ options: null as AxisSwipeOptions | null }));
vi.mock('./useAxisSwipe', () => ({
  useAxisSwipe: (options: AxisSwipeOptions) => {
    swipeRef.options = options;
    return options.enabled ? { onPointerDown: vi.fn() } : {};
  },
}));

beforeEach(() => {
  mobileRef.value = true;
  swipeRef.options = null;
});

const swipe = () => swipeRef.options!;
const release = (r: Partial<AxisSwipeRelease>) =>
  act(() => swipe().onRelease({ value: 0, velocity: 0, aborted: false, ...r }));

type MotionValue = { set: (v: number) => void; get: () => number };
type MotionProps = ReturnType<typeof useSwipeDismiss>['motionProps'] & {
  'data-swipe-surface'?: string;
  style?: { x?: MotionValue; y?: MotionValue; touchAction?: string };
};

describe('useSwipeDismiss', () => {
  it('returns no swipe props on desktop', () => {
    mobileRef.value = false;
    const { result } = renderHook(() => useSwipeDismiss('right', vi.fn()));
    expect(result.current.dismissing).toBe(false);
    expect(result.current.settled).toBe(true);
    expect(result.current.motionProps).toEqual({});
    expect(swipe().enabled).toBe(false);
  });

  it('is unsettled while the panel is off its resting position and settled at rest', () => {
    const { result } = renderHook(() => useSwipeDismiss('right', vi.fn()));
    const x = (result.current.motionProps as MotionProps).style!.x!;
    // A non-zero transform (sliding in / being dragged) un-settles it so the
    // right-rail panels keep their left border.
    act(() => x.set(140));
    expect(result.current.settled).toBe(false);
    // Back at rest → settled, border drops.
    act(() => x.set(0));
    expect(result.current.settled).toBe(true);
    // A sub-pixel residual still counts as settled.
    act(() => x.set(0.2));
    expect(result.current.settled).toBe(true);
  });

  it('makes a side panel a sideways swipe surface over its own x transform', () => {
    const { result } = renderHook(() => useSwipeDismiss('right', vi.fn()));
    const props = result.current.motionProps as MotionProps;
    expect(props['data-swipe-surface']).toBe('x');
    expect(swipe().axis).toBe('x');
    expect(swipe().value).toBe(props.style!.x);
    expect(swipe().range()).toEqual([0, window.innerWidth]);
  });

  it('keeps a sheet pan-y so its body scrolls natively, and swipes it down', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const props = result.current.motionProps as MotionProps;
    expect(props['data-swipe-surface']).toBe('y');
    expect(props.style?.touchAction).toBe('pan-y');
    expect(swipe().axis).toBe('y');
    expect(swipe().value).toBe(props.style!.y);
    expect(swipe().range()).toEqual([0, window.innerHeight]);
  });

  it('dismisses on a release past the commit distance, exactly once', async () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeDismiss('right', onDismiss));

    release({ value: 220 });
    expect(result.current.dismissing).toBe(true);

    // A release landing while the exit animation is still running is
    // swallowed (the dismissing latch) — onDismiss fires exactly once.
    release({ value: 220 });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses a short swipe released with a flick', async () => {
    const onDismiss = vi.fn();
    renderHook(() => useSwipeDismiss('down', onDismiss));
    release({ value: 30, velocity: 900 });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('springs back from a short release, and from one the browser took over', async () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeDismiss('right', onDismiss));
    const x = (result.current.motionProps as MotionProps).style!.x!;
    await waitFor(() => expect(x.get()).toBeLessThan(1));

    act(() => x.set(40));
    release({ value: 40 });
    expect(result.current.dismissing).toBe(false);
    await waitFor(() => expect(x.get()).toBeLessThan(1));

    act(() => x.set(260));
    release({ value: 260, velocity: 800, aborted: true });
    expect(result.current.dismissing).toBe(false);
    await waitFor(() => expect(x.get()).toBeLessThan(1));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  describe('where a swipe may start', () => {
    // jsdom reports 0 for both metrics, so the "can this actually scroll?"
    // question has to be stubbed explicitly.
    function sizeAs(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
      Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    }

    function sheetWith(...children: HTMLElement[]) {
      const root = document.createElement('div');
      root.setAttribute('data-swipe-surface', 'y');
      for (const child of children) root.appendChild(child);
      return root;
    }

    function scrollBody(canScroll: boolean) {
      const scroller = document.createElement('div');
      scroller.setAttribute('data-swipe-scroll', 'true');
      sizeAs(scroller, canScroll ? { scrollHeight: 900, clientHeight: 200 } : { scrollHeight: 100, clientHeight: 200 });
      return scroller;
    }

    function startsOn(target: EventTarget, root: Element) {
      renderHook(() => useSwipeDismiss('down', vi.fn()));
      return swipe().canStart(target, root);
    }

    it('a side panel swipes from anywhere on it but its text fields', () => {
      renderHook(() => useSwipeDismiss('right', vi.fn()));
      const panel = document.createElement('aside');
      panel.setAttribute('data-swipe-surface', 'x');
      const row = document.createElement('div');
      const field = document.createElement('textarea');
      panel.append(row, field);
      expect(swipe().canStart(row, panel)).toBe(true);
      expect(swipe().canStart(field, panel)).toBe(false);
    });

    it('starts from the explicit grab handle even over a scrollable body', () => {
      const scroller = scrollBody(true);
      const handle = document.createElement('div');
      handle.setAttribute('data-sheet-drag', 'true');
      scroller.appendChild(handle);
      expect(startsOn(handle, sheetWith(scroller))).toBe(true);
    });

    it('leaves the gesture to native scroll when the scroll body can scroll', () => {
      const scroller = scrollBody(true);
      const child = document.createElement('div');
      scroller.appendChild(child);
      expect(startsOn(child, sheetWith(scroller))).toBe(false);
    });

    it('starts from a swipe-scroll body that has no room to scroll', () => {
      const scroller = scrollBody(false);
      const child = document.createElement('div');
      scroller.appendChild(child);
      expect(startsOn(child, sheetWith(scroller))).toBe(true);
    });

    // The picker-won't-scroll regression: chrome that sits OUTSIDE the scroll
    // body (a shelf, a section label, the search row) must not claim a
    // vertical gesture while there is still something on screen to scroll.
    it('declines unmarked chrome while the sheet has something to scroll', () => {
      const chrome = document.createElement('div');
      expect(startsOn(chrome, sheetWith(scrollBody(true), chrome))).toBe(false);
    });

    it('starts from unmarked chrome when nothing in the sheet can scroll', () => {
      const chrome = document.createElement('div');
      expect(startsOn(chrome, sheetWith(scrollBody(false), chrome))).toBe(true);
    });

    it('starts from chrome in a sheet with no scroll body at all', () => {
      const chrome = document.createElement('div');
      expect(startsOn(chrome, sheetWith(chrome))).toBe(true);
    });

    it('ignores a touch whose target is not an element', () => {
      expect(startsOn(document, sheetWith())).toBe(false);
    });
  });

  // Regression: on a host that stays mounted while the panel toggles (a
  // message's action sheet on an always-mounted MessageItem), a swipe-dismiss
  // left `offset` off-screen and the dismiss latch armed. Reopening rendered the
  // sheet translated off-screen and undraggable — it "wouldn't pop up". The
  // `open` param must re-initialise the gesture on each open.
  it('re-initialises on reopen so a swipe-dismissed panel returns to rest and is draggable again', async () => {
    const onDismiss = vi.fn();
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useSwipeDismiss('down', onDismiss, open),
      { initialProps: { open: true } },
    );
    const y = () => (result.current.motionProps as MotionProps).style!.y!;
    await waitFor(() => expect(y().get()).toBeLessThan(1)); // enter settles to rest

    // Swipe past the commit distance → animates off-screen, then onComplete
    // fires onDismiss and clears the latch.
    release({ value: 300 });
    expect(result.current.dismissing).toBe(true);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));

    // Close, then reopen on the SAME hook instance.
    rerender({ open: false });
    rerender({ open: true });

    // Slides back to rest (not stuck off-screen) and the dismiss latch cleared.
    await waitFor(() => expect(y().get()).toBeLessThan(1));
    expect(result.current.dismissing).toBe(false);

    // Swipeable again: a second dismiss fires onDismiss.
    release({ value: 300 });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(2));
  });
});
