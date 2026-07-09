import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue';

describe('useDebouncedValue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the initial value synchronously', () => {
    const { result } = renderHook(() => useDebouncedValue('hello', 200));
    expect(result.current).toBe('hello');
  });

  it('updates after the delay elapses', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    expect(result.current).toBe('a');
    act(() => { vi.advanceTimersByTime(199); });
    expect(result.current).toBe('a');
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe('b');
  });

  it('resets the timer on rapid changes', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 200), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    act(() => { vi.advanceTimersByTime(150); });
    rerender({ value: 'c' });
    act(() => { vi.advanceTimersByTime(150); });
    // 150 + 150 = 300 elapsed but each change reset the timer, so the
    // 200ms quiet period has not elapsed since the last change.
    expect(result.current).toBe('a');
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current).toBe('c');
  });
});
