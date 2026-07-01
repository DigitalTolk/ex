import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLongPress } from './useLongPress';

// Haptics fire on a real long-press; stub so the test doesn't depend on the
// (native/vibrate) environment and we can assert it's invoked.
const hapticMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/haptics', () => ({
  triggerMessageActionHaptic: () => hapticMock(),
}));

// Minimal React.PointerEvent stand-in — the hook only reads pointerType and
// clientX/clientY off it.
function pointer(
  overrides: Partial<{ pointerType: string; clientX: number; clientY: number }> = {},
): React.PointerEvent {
  return {
    pointerType: 'touch',
    clientX: 0,
    clientY: 0,
    ...overrides,
  } as React.PointerEvent;
}

const DELAY = 100;

beforeEach(() => {
  vi.useFakeTimers();
  hapticMock.mockReset();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('useLongPress', () => {
  it('fires onLongPress after the delay and marks the click for suppression', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: DELAY }));

    act(() => {
      result.current.handlers.onPointerDown(pointer());
    });
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(hapticMock).toHaveBeenCalledTimes(1);

    // The click that follows the release is suppressed exactly once.
    expect(result.current.shouldSuppressClick()).toBe(true);
    expect(result.current.shouldSuppressClick()).toBe(false);
  });

  it('does not fire when released before the delay', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: DELAY }));

    act(() => {
      result.current.handlers.onPointerDown(pointer());
    });
    act(() => {
      vi.advanceTimersByTime(DELAY - 20);
      result.current.handlers.onPointerUp();
    });
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });

    expect(onLongPress).not.toHaveBeenCalled();
    expect(result.current.shouldSuppressClick()).toBe(false);
  });

  it('cancels via a window pointerup before the delay', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: DELAY }));

    act(() => {
      result.current.handlers.onPointerDown(pointer());
    });
    act(() => {
      window.dispatchEvent(new Event('pointerup'));
      vi.advanceTimersByTime(DELAY);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('cancels when the pointer moves beyond the threshold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: DELAY }));

    act(() => {
      result.current.handlers.onPointerDown(pointer({ clientX: 0, clientY: 0 }));
    });
    // A small drift stays armed...
    act(() => {
      result.current.handlers.onPointerMove(pointer({ clientX: 3, clientY: 2 }));
    });
    // ...a big drift cancels.
    act(() => {
      result.current.handlers.onPointerMove(pointer({ clientX: 40, clientY: 0 }));
      vi.advanceTimersByTime(DELAY);
    });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('ignores pointermove when no press is in flight', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: DELAY }));

    // No pointerdown first — the move must be a no-op (timerRef null guard).
    act(() => {
      result.current.handlers.onPointerMove(pointer({ clientX: 99, clientY: 99 }));
      vi.advanceTimersByTime(DELAY);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('never fires when disabled', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, enabled: false, delayMs: DELAY }));

    act(() => {
      result.current.handlers.onPointerDown(pointer());
      vi.advanceTimersByTime(DELAY);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('never fires for a mouse pointer (touch-only)', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: DELAY }));

    act(() => {
      result.current.handlers.onPointerDown(pointer({ pointerType: 'mouse' }));
      vi.advanceTimersByTime(DELAY);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('uses the ~450ms default delay when none is supplied', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress }));

    act(() => {
      result.current.handlers.onPointerDown(pointer());
      vi.advanceTimersByTime(449);
    });
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('picks up the latest onLongPress callback across re-renders', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ cb }) => useLongPress({ onLongPress: cb, delayMs: DELAY }),
      { initialProps: { cb: first } },
    );

    rerender({ cb: second });
    act(() => {
      result.current.handlers.onPointerDown(pointer());
      vi.advanceTimersByTime(DELAY);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clears a pending timer on unmount', () => {
    const onLongPress = vi.fn();
    const { result, unmount } = renderHook(() => useLongPress({ onLongPress, delayMs: DELAY }));

    act(() => {
      result.current.handlers.onPointerDown(pointer());
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(DELAY);
    });
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('resets a stale suppression on a fresh press so the next tap navigates', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress({ onLongPress, delayMs: DELAY }));

    // Long-press fires but the click never arrives (e.g. release off-target).
    act(() => {
      result.current.handlers.onPointerDown(pointer());
      vi.advanceTimersByTime(DELAY);
    });
    expect(onLongPress).toHaveBeenCalledTimes(1);

    // A brand-new short press must clear the stale suppress flag.
    act(() => {
      result.current.handlers.onPointerDown(pointer());
      result.current.handlers.onPointerUp();
    });
    expect(result.current.shouldSuppressClick()).toBe(false);
  });
});
