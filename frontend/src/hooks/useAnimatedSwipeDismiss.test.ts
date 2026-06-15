import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSwipeable } from 'react-swipeable';
import { SWIPE_DISMISS_MS, useAnimatedSwipeDismiss } from './useAnimatedSwipeDismiss';

vi.mock('react-swipeable', () => ({
  useSwipeable: vi.fn((config) => ({ ref: vi.fn(), ...config })),
}));

interface SwipeConfig {
  preventScrollOnSwipe: boolean;
  onSwiping: (event: { absX: number; absY: number; deltaX: number; deltaY: number; initial: [number, number]; event: Event }) => void;
  onSwipedRight: (event: { absY: number; deltaX: number; initial: [number, number] }) => void;
  onSwipedDown: (event: { absX: number; deltaY: number; event: Event }) => void;
  onSwiped: () => void;
}

function swipeConfig() {
  return vi.mocked(useSwipeable).mock.calls.at(-1)?.[0] as SwipeConfig;
}

function setMobileMatch(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: '(max-width: 767px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
}

describe('useAnimatedSwipeDismiss', () => {
  beforeEach(() => {
    setMobileMatch(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function eventFor(target: EventTarget = document.body) {
    return { target, cancelable: true, preventDefault: vi.fn() } as unknown as Event;
  }

  it('ignores swipe motion on desktop-width layouts', () => {
    setMobileMatch(false);
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('down', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 4, absY: 88, deltaX: 4, deltaY: 88, initial: [80, 80], event: eventFor() }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwipedDown({ absX: 4, deltaY: 88, event: eventFor() }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not globally block page scroll while right sidebars listen for horizontal dismissal', () => {
    renderHook(() => useAnimatedSwipeDismiss('right', vi.fn()));

    expect(swipeConfig().preventScrollOnSwipe).toBe(false);
  });

  it('blocks page scroll only after intentional horizontal right-sidebar dismissal begins', () => {
    renderHook(() => useAnimatedSwipeDismiss('right', vi.fn()));

    const vertical = eventFor();
    act(() => swipeConfig().onSwiping({ absX: 4, absY: 88, deltaX: 4, deltaY: 88, initial: [12, 120], event: vertical }));
    expect(vertical.preventDefault).not.toHaveBeenCalled();

    const horizontal = eventFor();
    act(() => swipeConfig().onSwiping({ absX: 60, absY: 8, deltaX: 60, deltaY: 8, initial: [12, 120], event: horizontal }));
    expect(horizontal.preventDefault).toHaveBeenCalled();
  });

  it('allows picker content to scroll while bottom sheets listen for swipe-down dismissal', () => {
    renderHook(() => useAnimatedSwipeDismiss('down', vi.fn()));

    expect(swipeConfig().preventScrollOnSwipe).toBe(false);
  });

  it('tracks right drag offset and settles back on a cancelled swipe', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 60, absY: 8, deltaX: 60, deltaY: 8, initial: [12, 120], event: eventFor() }));
    expect(result.current.dragStyle).toEqual({
      transform: 'translateX(60px)',
      transition: 'none',
    });

    act(() => swipeConfig().onSwipedRight({ absY: 8, deltaX: 60, initial: [12, 120] }));
    expect(result.current.dragOffset).toBe(0);
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not call preventDefault for non-cancelable rightward swipe events', () => {
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', vi.fn()));
    const event = { target: document.body, cancelable: false, preventDefault: vi.fn() } as unknown as Event;

    act(() => swipeConfig().onSwiping({ absX: 60, absY: 8, deltaX: 60, deltaY: 8, initial: [12, 120], event }));
    // The drag offset still tracks, but preventDefault is skipped because the
    // event is not cancelable.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(result.current.dragStyle).toEqual({ transform: 'translateX(60px)', transition: 'none' });
  });

  it('settles a rightward swipe release back to rest on desktop layouts', () => {
    setMobileMatch(false);
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwipedRight({ absY: 8, deltaX: 100, initial: [12, 120] }));
    expect(result.current.dragOffset).toBe(0);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('ignores wrong-direction and diagonal right drags', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 20, absY: 4, deltaX: -20, deltaY: 4, initial: [12, 120], event: eventFor() }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwiping({ absX: 80, absY: 80, deltaX: 80, deltaY: 80, initial: [12, 120], event: eventFor() }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwipedRight({ absY: 80, deltaX: 100, initial: [12, 120] }));
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('ignores right drags that do not start on the panel edge', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 80, absY: 8, deltaX: 80, deltaY: 8, initial: [120, 160], event: eventFor() }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwipedRight({ absY: 8, deltaX: 100, initial: [120, 160] }));
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('animates a right dismissal and ignores duplicate commits until the timer finishes', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 90, absY: 4, deltaX: 90, deltaY: 4, initial: [12, 120], event: eventFor() }));
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

  it('ignores drag updates while a dismissal timer is already pending', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('right', vi.fn()));

    act(() => swipeConfig().onSwipedRight({ absY: 4, deltaX: 90, initial: [12, 120] }));
    act(() => swipeConfig().onSwiping({ absX: 40, absY: 4, deltaX: 40, deltaY: 4, initial: [12, 120], event: eventFor() }));

    expect(result.current.dismissing).toBe(true);
    expect(result.current.dragStyle).toBeUndefined();
    vi.useRealTimers();
  });

  it('tracks down drag offset and dismisses downward sheets', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('down', onDismiss));

    const event = eventFor();
    act(() => swipeConfig().onSwiping({ absX: 8, absY: 88, deltaX: 8, deltaY: 88, initial: [80, 80], event }));
    expect(result.current.dragStyle).toEqual({
      transform: 'translateY(88px)',
      transition: 'none',
    });

    expect(event.preventDefault).toHaveBeenCalled();

    act(() => swipeConfig().onSwipedDown({ absX: 8, deltaY: 88, event: eventFor() }));
    expect(result.current.dismissing).toBe(true);
    expect(result.current.dragOffset).toBe(0);

    act(() => vi.advanceTimersByTime(SWIPE_DISMISS_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('ignores wrong-direction and diagonal down drags', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('down', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 4, absY: 20, deltaX: 4, deltaY: -20, initial: [80, 80], event: eventFor() }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwiping({ absX: 80, absY: 90, deltaX: 80, deltaY: 90, initial: [80, 80], event: eventFor() }));
    expect(result.current.dragStyle).toBeUndefined();

    act(() => swipeConfig().onSwipedDown({ absX: 80, deltaY: 100, event: eventFor() }));
    expect(result.current.dismissing).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not hijack downward scrolling inside picker content that is already scrolled', () => {
    const onDismiss = vi.fn();
    const scroller = document.createElement('div');
    scroller.dataset.swipeScroll = 'true';
    scroller.scrollTop = 40;
    document.body.appendChild(scroller);
    const { result } = renderHook(() => useAnimatedSwipeDismiss('down', onDismiss));

    act(() => swipeConfig().onSwiping({ absX: 4, absY: 90, deltaX: 4, deltaY: 90, initial: [80, 80], event: eventFor(scroller) }));
    expect(result.current.dragStyle).toBeUndefined();
    act(() => swipeConfig().onSwipedDown({ absX: 4, deltaY: 90, event: eventFor(scroller) }));
    expect(onDismiss).not.toHaveBeenCalled();
    scroller.remove();
  });

  it('handles non-element swipe targets without treating them as picker scrollers', () => {
    const onDismiss = vi.fn();
    const { result } = renderHook(() => useAnimatedSwipeDismiss('down', onDismiss));

    act(() => swipeConfig().onSwiping({
      absX: 4,
      absY: 88,
      deltaX: 4,
      deltaY: 88,
      initial: [80, 80],
      event: eventFor(window),
    }));

    expect(result.current.dragStyle).toEqual({
      transform: 'translateY(88px)',
      transition: 'none',
    });
  });

  it('does not call preventDefault for non-cancelable downward swipe events', () => {
    const { result } = renderHook(() => useAnimatedSwipeDismiss('down', vi.fn()));
    const event = { target: document.body, cancelable: false, preventDefault: vi.fn() } as unknown as Event;

    act(() => swipeConfig().onSwiping({ absX: 4, absY: 88, deltaX: 4, deltaY: 88, initial: [80, 80], event }));

    expect(result.current.dragStyle).toEqual({
      transform: 'translateY(88px)',
      transition: 'none',
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
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
