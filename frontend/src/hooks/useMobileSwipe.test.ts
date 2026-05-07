import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSwipeable } from 'react-swipeable';
import { useMobileSwipe } from './useMobileSwipe';

vi.mock('react-swipeable', () => ({
  useSwipeable: vi.fn((config) => config),
}));

function swipeConfig() {
  return vi.mocked(useSwipeable).mock.calls.at(-1)?.[0] as {
    onSwipedLeft: (event: { absY: number }) => void;
    onSwipedRight: (event: { absY: number }) => void;
    onSwipedDown: (event: { absX: number; absY: number }) => void;
  };
}

describe('useMobileSwipe', () => {
  it('fires only for the requested horizontal direction', () => {
    const onSwipe = vi.fn();
    renderHook(() => useMobileSwipe('left', onSwipe));

    swipeConfig().onSwipedRight({ absY: 4 });
    expect(onSwipe).not.toHaveBeenCalled();

    swipeConfig().onSwipedLeft({ absY: 4 });
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  it('ignores vertical drift for right swipes', () => {
    const onSwipe = vi.fn();
    renderHook(() => useMobileSwipe('right', onSwipe));

    swipeConfig().onSwipedRight({ absY: 80 });

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('ignores vertical drift for left swipes', () => {
    const onSwipe = vi.fn();
    renderHook(() => useMobileSwipe('left', onSwipe));

    swipeConfig().onSwipedLeft({ absY: 80 });

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('fires for a valid right swipe only when configured for right', () => {
    const onSwipe = vi.fn();
    renderHook(() => useMobileSwipe('right', onSwipe));

    swipeConfig().onSwipedLeft({ absY: 4 });
    expect(onSwipe).not.toHaveBeenCalled();

    swipeConfig().onSwipedRight({ absY: 4 });
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  it('fires for a vertical down swipe', () => {
    const onSwipe = vi.fn();
    renderHook(() => useMobileSwipe('down', onSwipe));

    swipeConfig().onSwipedDown({ absX: 8, absY: 90 });

    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  it('ignores short or horizontal-heavy down swipes', () => {
    const onSwipe = vi.fn();
    renderHook(() => useMobileSwipe('down', onSwipe));

    swipeConfig().onSwipedDown({ absX: 8, absY: 40 });
    swipeConfig().onSwipedDown({ absX: 80, absY: 90 });

    expect(onSwipe).not.toHaveBeenCalled();
  });
});
