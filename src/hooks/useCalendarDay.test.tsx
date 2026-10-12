import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { startOfToday, useCalendarDay } from './useCalendarDay';

describe('useCalendarDay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is local midnight today and rolls over at midnight', () => {
    vi.setSystemTime(new Date(2026, 9, 12, 23, 59, 30));
    const { result } = renderHook(() => useCalendarDay());
    expect(result.current.getTime()).toBe(new Date(2026, 9, 12).getTime());
    expect(startOfToday().getTime()).toBe(new Date(2026, 9, 12).getTime());
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(result.current.getDate()).toBe(12);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.getTime()).toBe(new Date(2026, 9, 13).getTime());
  });
});
