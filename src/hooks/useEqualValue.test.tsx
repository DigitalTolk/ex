import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEqualValue } from './useEqualValue';

const sameLength = (a: number[], b: number[]) => a.length === b.length;

describe('useEqualValue', () => {
  it('keeps the previous value while equal, and adopts a changed one in the same render', () => {
    const first = [1, 2];
    const { result, rerender } = renderHook(({ v }) => useEqualValue(v, sameLength), { initialProps: { v: first } });
    expect(result.current).toBe(first);
    rerender({ v: [3, 4] });
    expect(result.current).toBe(first);
    const changed = [1, 2, 3];
    rerender({ v: changed });
    expect(result.current).toBe(changed);
    rerender({ v: changed });
    expect(result.current).toBe(changed);
  });
});
