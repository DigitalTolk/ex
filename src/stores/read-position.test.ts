import { afterEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  clearReadPosition,
  getAckedThrough,
  getReadThrough,
  isListAtBottom,
  setAckedThrough,
  setListAtBottom,
  setReadThrough,
  useListAtBottom,
  useReadPositionStore,
  useReadThrough,
} from './read-position';

afterEach(() => {
  act(() => useReadPositionStore.setState({ atBottom: {}, readThrough: {}, ackedThrough: {} }));
});

describe('read-position store', () => {
  it('defaults an unknown parent to at-bottom (the default open position)', () => {
    expect(isListAtBottom('p1')).toBe(true);
    const { result } = renderHook(() => useListAtBottom('p1'));
    expect(result.current).toBe(true);
  });

  it('tracks at-bottom per parent and skips no-op writes', () => {
    setListAtBottom('p1', false);
    const before = useReadPositionStore.getState();
    setListAtBottom('p1', false);
    expect(useReadPositionStore.getState()).toBe(before);
    expect(isListAtBottom('p1')).toBe(false);
    expect(isListAtBottom('p2')).toBe(true);
  });

  it('useListAtBottom re-renders on change and reads true without a parent', () => {
    const { result } = renderHook(() => useListAtBottom('p1'));
    act(() => setListAtBottom('p1', false));
    expect(result.current).toBe(false);
    const { result: none } = renderHook(() => useListAtBottom(undefined));
    expect(none.current).toBe(true);
  });

  it('readThrough only moves forward', () => {
    setReadThrough('p1', '01B');
    setReadThrough('p1', '01A');
    expect(getReadThrough('p1')).toBe('01B');
    setReadThrough('p1', '01C');
    expect(getReadThrough('p1')).toBe('01C');
    const { result } = renderHook(() => useReadThrough('p1'));
    expect(result.current).toBe('01C');
    const { result: none } = renderHook(() => useReadThrough(undefined));
    expect(none.current).toBeUndefined();
  });

  it('clearReadPosition forgets a parent and is a no-op for unknown ones', () => {
    setListAtBottom('p1', false);
    setReadThrough('p1', '01B');
    clearReadPosition('p1');
    expect(isListAtBottom('p1')).toBe(true);
    expect(getReadThrough('p1')).toBeUndefined();
    const before = useReadPositionStore.getState();
    clearReadPosition('p1');
    expect(useReadPositionStore.getState()).toBe(before);
  });

  it('clearReadPosition works when only one side is set', () => {
    setReadThrough('p2', '01A');
    clearReadPosition('p2');
    expect(getReadThrough('p2')).toBeUndefined();
  });
});

describe('ackedThrough', () => {
  it('only moves forward and is forgotten with the parent', () => {
    setAckedThrough('p1', '01B');
    setAckedThrough('p1', '01A');
    expect(getAckedThrough('p1')).toBe('01B');
    clearReadPosition('p1');
    expect(getAckedThrough('p1')).toBeUndefined();
    setAckedThrough('p3', '01A');
    clearReadPosition('p3');
    expect(getAckedThrough('p3')).toBeUndefined();
  });
});
