import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSwipeable } from 'react-swipeable';
import { SWIPE_DISMISS_MS, useAnimatedSwipeDismiss } from './useAnimatedSwipeDismiss';

vi.mock('react-swipeable', () => ({
  useSwipeable: vi.fn((config) => ({ ref: vi.fn(), ...config })),
}));

interface SwipeConfig {
  preventScrollOnSwipe: boolean;
  onSwiping: (event: { absX: number; absY: number; deltaX: number; deltaY: number; initial: [number, number] }) => void;
  onSwipedRight: (event: { absY: number; deltaX: number; initial: [number, number] }) => void;
  onSwipedDown: (event: { absX: number; deltaY: number }) => void;
  onSwiped: () => void;
}

function swipeConfig() {
  return vi.mocked(useSwipeable).mock.calls.at(-1)?.[0] as SwipeConfig;
}

describe('useAnimatedSwipeDismiss', () => {
  it('allows normal scroll while right sidebars listen for horizontal dismissal', () => {
    renderHook(() => useAnimatedSwipeDismiss('right', vi.fn()));

    expect(swipeConfig().preventScrollOnSwipe).toBe(false);
  });

  it('prevents page scroll while bottom sheets listen for swipe-down dismissal', () => {
    renderHook(() => useAnimatedSwipeDismiss('down', vi.fn()));

    expect(swipeConfig().preventScrollOnSwipe).toBe(true);
  });

  it('tracks right drag offset and settles back on a cancelled swipe', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 60, absY: 8, deltaX: 60, deltaY: 8, initial: [12, 120] }));
    expect(result.current.dragStyle).toEqual({
      transform: 'translateX(60px)',
      transition: 'none',
    });

    act(() => swipeConfig().onSwipedRight({ absY: 8, deltaX: 60, initial: [12, 120] }));
    expect(result.current.dragOffset).toBe(0);
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('ignores wrong-direction and diagonal right drags', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 20, absY: 4, deltaX: -20, deltaY: 4, initial: [12, 120] }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwiping({ absX: 80, absY: 80, deltaX: 80, deltaY: 80, initial: [12, 120] }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwipedRight({ absY: 80, deltaX: 100, initial: [12, 120] }));
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('ignores right drags that do not start on the panel edge', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 80, absY: 8, deltaX: 80, deltaY: 8, initial: [120, 160] }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwipedRight({ absY: 8, deltaX: 100, initial: [120, 160] }));
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('animates a right dismissal and ignores duplicate commits until the timer finishes', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 90, absY: 4, deltaX: 90, deltaY: 4, initial: [12, 120] }));
    act(() => swipeConfig().onSwipedRight({ absY: 4, deltaX: 90, initial: [12, 120] }));
    act(() => swipeConfig().onSwipedRight({ absY: 4, deltaX: 90, initial: [12, 120] }));
    act(() => swipeConfig().onSwiped());

    expect(result.current.dismissing).toBe(true);
    expect(result.current.dragStyle).toBeUndefined();
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(SWIPE_DISMISS_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(result.current.dismissing).toBe(false);
    vi.useRealTimers();
  });

  it('tracks down drag offset and dismisses downward sheets', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('down', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 8, absY: 88, deltaX: 8, deltaY: 88, initial: [80, 80] }));
    expect(result.current.dragStyle).toEqual({
      transform: 'translateY(88px)',
      transition: 'none',
    });

    act(() => swipeConfig().onSwipedDown({ absX: 8, deltaY: 88 }));
    expect(result.current.dismissing).toBe(true);
    expect(result.current.dragOffset).toBe(0);

    act(() => vi.advanceTimersByTime(SWIPE_DISMISS_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ignores wrong-direction and diagonal down drags', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('down', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 4, absY: 20, deltaX: 4, deltaY: -20, initial: [80, 80] }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwiping({ absX: 80, absY: 90, deltaX: 80, deltaY: 90, initial: [80, 80] }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwipedDown({ absX: 80, deltaY: 100 }));
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('clears a pending dismissal timer on unmount', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { unmount } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwipedRight({ absY: 4, deltaX: 90, initial: [12, 120] }));
    unmount();
    act(() => vi.advanceTimersByTime(SWIPE_DISMISS_MS));

    expect(onDismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
