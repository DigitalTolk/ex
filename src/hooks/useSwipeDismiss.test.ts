import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PanInfo } from 'motion/react';
import { useSwipeDismiss } from './useSwipeDismiss';

const mobileRef = { value: true };
vi.mock('./useIsMobile', () => ({ useIsMobile: () => mobileRef.value }));

// Observe imperative drag starts without disturbing the rest of motion/react
// (the enter/exit animations in these tests run the real engine).
const dragControlsMock = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('motion/react', async (orig) => ({
  ...(await orig<typeof import('motion/react')>()),
  useDragControls: () => dragControlsMock,
}));

beforeEach(() => {
  mobileRef.value = true;
  dragControlsMock.start.mockReset();
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

    // A drag-end landing while the exit animation is still running is
    // swallowed (the dismissingRef latch) — onDismiss fires exactly once.
    act(() => props.onDragEnd?.(new Event('pointerup') as PointerEvent, pan(120, 0)));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(onDismiss).toHaveBeenCalledTimes(1);
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

  it('never hands Motion the vertical pointerdown (no touch-action override on the sheet)', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const props = result.current.motionProps as MotionProps & {
      dragListener?: boolean;
      style?: { touchAction?: string };
    };
    // dragListener:false is what keeps Motion from forcing touch-action:pan-x
    // onto the whole sheet (which WebKit honors subtree-wide, freezing the
    // emoji grid); the explicit pan-y keeps native panning available.
    expect(props.drag).toBe('y');
    expect(props.dragListener).toBe(false);
    expect(props.style?.touchAction).toBe('pan-y');
  });

  // jsdom reports 0 for both metrics, so the "can this actually scroll?"
  // question has to be stubbed explicitly.
  function sizeAs(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  }

  function sheetWith(body: HTMLElement) {
    const root = document.createElement('div');
    root.appendChild(body);
    return root;
  }

  function pointerDownOn(
    props: MotionProps,
    target: EventTarget | null,
    currentTarget: EventTarget | null,
  ) {
    act(() => props.onPointerDown?.({ target, currentTarget } as unknown as React.PointerEvent));
  }

  it('starts the vertical drag from the explicit grab handle even over a scrollable body', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const scroller = document.createElement('div');
    scroller.setAttribute('data-swipe-scroll', 'true');
    sizeAs(scroller, { scrollHeight: 900, clientHeight: 200 });
    const handle = document.createElement('div');
    handle.setAttribute('data-sheet-drag', 'true');
    scroller.appendChild(handle);
    pointerDownOn(result.current.motionProps as MotionProps, handle, sheetWith(scroller));
    expect(dragControlsMock.start).toHaveBeenCalledTimes(1);
  });

  it('leaves the gesture to native scroll when the scroll body can scroll', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const scroller = document.createElement('div');
    scroller.setAttribute('data-swipe-scroll', 'true');
    sizeAs(scroller, { scrollHeight: 900, clientHeight: 200 });
    const child = document.createElement('div');
    scroller.appendChild(child);
    pointerDownOn(result.current.motionProps as MotionProps, child, sheetWith(scroller));
    expect(dragControlsMock.start).not.toHaveBeenCalled();
  });

  it('starts the drag from a swipe-scroll body that has no room to scroll', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const scroller = document.createElement('div');
    scroller.setAttribute('data-swipe-scroll', 'true');
    sizeAs(scroller, { scrollHeight: 100, clientHeight: 200 });
    const child = document.createElement('div');
    scroller.appendChild(child);
    pointerDownOn(result.current.motionProps as MotionProps, child, sheetWith(scroller));
    expect(dragControlsMock.start).toHaveBeenCalledTimes(1);
  });

  // The picker-won't-scroll regression: chrome that sits OUTSIDE the scroll
  // body (a shelf, a section label, the search row) must not claim a vertical
  // gesture while there is still something on screen to scroll — the drag is
  // pinned upward, so claiming it means the finger moves and nothing happens.
  it('declines a drag from unmarked chrome while the sheet has something to scroll', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const scroller = document.createElement('div');
    scroller.setAttribute('data-swipe-scroll', 'true');
    sizeAs(scroller, { scrollHeight: 900, clientHeight: 200 });
    const root = sheetWith(scroller);
    const chrome = document.createElement('div');
    root.appendChild(chrome);
    pointerDownOn(result.current.motionProps as MotionProps, chrome, root);
    expect(dragControlsMock.start).not.toHaveBeenCalled();
  });

  it('starts the drag from unmarked chrome when nothing in the sheet can scroll', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const scroller = document.createElement('div');
    scroller.setAttribute('data-swipe-scroll', 'true');
    sizeAs(scroller, { scrollHeight: 100, clientHeight: 200 });
    const root = sheetWith(scroller);
    const chrome = document.createElement('div');
    root.appendChild(chrome);
    pointerDownOn(result.current.motionProps as MotionProps, chrome, root);
    expect(dragControlsMock.start).toHaveBeenCalledTimes(1);
  });

  it('starts the drag from chrome in a sheet with no scroll body at all', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    const root = document.createElement('div');
    const chrome = document.createElement('div');
    root.appendChild(chrome);
    pointerDownOn(result.current.motionProps as MotionProps, chrome, root);
    expect(dragControlsMock.start).toHaveBeenCalledTimes(1);
  });

  it('ignores a pointerdown whose target is not an element', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    pointerDownOn(result.current.motionProps as MotionProps, document, document.createElement('div'));
    expect(dragControlsMock.start).not.toHaveBeenCalled();
  });

  it('falls back to starting the drag when the sheet root is not an element', () => {
    const { result } = renderHook(() => useSwipeDismiss('down', vi.fn()));
    pointerDownOn(result.current.motionProps as MotionProps, document.createElement('div'), null);
    expect(dragControlsMock.start).toHaveBeenCalledTimes(1);
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
