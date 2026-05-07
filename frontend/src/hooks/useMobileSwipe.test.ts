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
});
