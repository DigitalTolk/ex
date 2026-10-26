import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEventCallback } from './useEventCallback';

describe('useEventCallback', () => {
  it('keeps one identity across renders and always calls the latest function', () => {
    const { result, rerender } = renderHook(({ n }) => useEventCallback((x: number) => x + n), {
      initialProps: { n: 1 },
    });
    const first = result.current;
    expect(first(1)).toBe(2);
    rerender({ n: 10 });
    expect(result.current).toBe(first);
    expect(result.current(1)).toBe(11);
  });
});
