import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PanInfo } from 'motion/react';
import { useSwipeDismiss } from './useSwipeDismiss';

const mobileRef = { value: true };
vi.mock('./useIsMobile', () => ({ useIsMobile: () => mobileRef.value }));

beforeEach(() => {
  mobileRef.value = true;
});

function pan(x: number, y: number, vx = 0, vy = 0): PanInfo {
  return {
    point: { x: 0, y: 0 },
    delta: { x: 0, y: 0 },
    offset: { x, y },
    velocity: { x: vx, y: vy },
  };
}

type MotionValue = { set: (v: number) => void; get: () => number };
type MotionProps = ReturnType<typeof useSwipeDismiss>['motionProps'] & {
  drag?: 'x' | 'y' | false;
  onDragEnd?: (e: PointerEvent, info: PanInfo) => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  style?: { x?: MotionValue; y?: MotionValue };
};

describe('useSwipeDismiss', () => {
  it('returns no drag props on desktop', () => {
    mobileRef.value = false;
    const { result } = renderHook(() => useSwipeDismiss('right', vi.fn()));
    expect(result.current.dismissing).toBe(false);
    expect(result.current.settled).toBe(true);
    expect(result.current.motionProps).toEqual({});
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

  it('arms horizontal drag and dismisses past the distance threshold', async () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeDismiss('right', onDismiss));
    const props = result.current.motionProps as MotionProps;
    expect(props.drag).toBe('x');

    act(() => props.onDragEnd?.(new Event('pointerup') as PointerEvent, pan(120, 0)));
    expect(result.current.dismissing).toBe(true);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('springs back and does not dismiss below the threshold', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeDismiss('right', onDismiss));
    const props = result.current.motionProps as MotionProps;
    act(() => props.onDragEnd?.(new Event('pointerup') as PointerEvent, pan(40, 0)));
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses on a fast flick even below the distance threshold', async () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeDismiss('down', onDismiss));
    const props = result.current.motionProps as MotionProps;
    expect(props.drag).toBe('y');
    act(() => props.onDragEnd?.(new Event('pointerup') as PointerEvent, pan(0, 30, 0, 800)));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('dismisses a horizontal drag on a fast flick below the distance threshold', async () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useSwipeDismiss('right', onDismiss));
    const props = result.current.motionProps as MotionProps;
    act(() => props.onDragEnd?.(new Event('pointerup') as PointerEvent, pan(20, 0, 800, 0)));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it('arms the vertical drag when the pointer is not over a scroll body', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    act(() =>
      (result.current.motionProps as MotionProps).onPointerDown?.({
        target: document,
      } as unknown as React.PointerEvent),
    );
    expect((result.current.motionProps as MotionProps).drag).toBe('y');
  });

  it('disarms the vertical drag when the scroll body is not at the top', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const scroller = document.createElement('div');
    scroller.setAttribute('data-swipe-scroll', 'true');
    Object.defineProperty(scroller, 'scrollTop', { value: 50, configurable: true });
    const child = document.createElement('div');
    scroller.appendChild(child);
    act(() =>
      (result.current.motionProps as MotionProps).onPointerDown?.({
        target: child,
      } as unknown as React.PointerEvent),
    );
    expect((result.current.motionProps as MotionProps).drag).toBe(false);
  });

  // Regression: on a host that stays mounted while the panel toggles (a
  // message's action sheet on an always-mounted MessageItem), a swipe-dismiss
  // left `offset` off-screen and the drag latch armed. Reopening rendered the
  // sheet translated off-screen and undraggable — it "wouldn't pop up". The
  // `open` param must re-initialise the gesture on each open. This exercises the
  // REAL hook (not the component mocks), which is why the bug slipped through.
  it('re-initialises on reopen so a swipe-dismissed panel returns to rest and is draggable again', async () => {
    const onDismiss = vi.fn();
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useSwipeDismiss('down', onDismiss, open),
      { initialProps: { open: true } },
    );
    const y = () => (result.current.motionProps as MotionProps).style!.y!;
    await waitFor(() => expect(y().get()).toBeLessThan(1)); // enter settles to rest

    // Swipe past the threshold → animates off-screen, then onComplete fires
    // onDismiss and clears the latch.
    act(() => (result.current.motionProps as MotionProps).onDragEnd?.(new Event('pointerup') as PointerEvent, pan(0, 120)));
    expect(result.current.dismissing).toBe(true);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));

    // Close, then reopen on the SAME hook instance.
    rerender({ open: false });
    rerender({ open: true });

    // Slides back to rest (not stuck off-screen) and the dismiss latch cleared.
    await waitFor(() => expect(y().get()).toBeLessThan(1));
    expect(result.current.dismissing).toBe(false);

    // Draggable again: a second dismiss fires onDismiss (before the fix the
    // latched dismissingRef made onDragEnd a no-op, so this never fired twice).
    act(() => (result.current.motionProps as MotionProps).onDragEnd?.(new Event('pointerup') as PointerEvent, pan(0, 120)));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(2));
  });
});
