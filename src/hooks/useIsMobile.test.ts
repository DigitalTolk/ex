import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile } from './useIsMobile';

function installMatchMedia(matches: boolean, legacy = false) {
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const addEventListener = vi.fn((_event: string, cb: (event: { matches: boolean }) => void) => {
    listeners.add(cb);
  });
  const removeEventListener = vi.fn((_event: string, cb: (event: { matches: boolean }) => void) => {
    listeners.delete(cb);
  });
  const addListener = vi.fn((cb: (event: { matches: boolean }) => void) => {
    listeners.add(cb);
  });
  const removeListener = vi.fn((cb: (event: { matches: boolean }) => void) => {
    listeners.delete(cb);
  });
  const query = {
    matches,
    media: '(max-width: 767px)',
    addEventListener: legacy ? undefined : addEventListener,
    removeEventListener: legacy ? undefined : removeEventListener,
    addListener,
    removeListener,
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => query),
  });
  return {
    query,
    addEventListener,
    removeEventListener,
    addListener,
    removeListener,
    emit(next: boolean) {
      query.matches = next;
      for (const listener of listeners) listener({ matches: next });
    },
  };
}

describe('useIsMobile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tracks modern matchMedia change events', () => {
    const media = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
    act(() => media.emit(true));
    expect(result.current).toBe(true);
    unmount();
    expect(media.removeEventListener).toHaveBeenCalled();
  });

  it('falls back to legacy matchMedia listeners', () => {
    const media = installMatchMedia(true, true);
    const { result, unmount } = renderHook(() => useIsMobile());

    expect(result.current).toBe(true);
    expect(media.addListener).toHaveBeenCalled();
    act(() => media.emit(false));
    expect(result.current).toBe(false);
    unmount();
    expect(media.removeListener).toHaveBeenCalled();
  });

  it('returns false when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: undefined,
    });
    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });
});
