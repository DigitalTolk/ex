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

  it('shares one media query and one change listener across every mounted row', () => {
    // Every message row asks; a channel mounts dozens of them. Each used to
    // build its own MediaQueryList and listener.
    const media = installMatchMedia(false);
    const hooks = Array.from({ length: 25 }, () => renderHook(() => useIsMobile()));

    expect(window.matchMedia).toHaveBeenCalledTimes(1);
    expect(media.addEventListener).toHaveBeenCalledTimes(1);

    // One change still reaches every row.
    act(() => media.emit(true));
    for (const hook of hooks) expect(hook.result.current).toBe(true);

    // The listener stays while any row is mounted and goes with the last one.
    for (const hook of hooks.slice(1)) hook.unmount();
    expect(media.removeEventListener).not.toHaveBeenCalled();
    hooks[0].unmount();
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('follows a replaced matchMedia (a new viewport emulation)', () => {
    const before = installMatchMedia(false);
    const first = renderHook(() => useIsMobile());
    expect(first.result.current).toBe(false);

    // Replaced while a row is still mounted: the shared listener moves over.
    const after = installMatchMedia(false);
    const second = renderHook(() => useIsMobile());
    expect(before.removeEventListener).toHaveBeenCalledTimes(1);
    expect(after.addEventListener).toHaveBeenCalledTimes(1);
    act(() => after.emit(true));
    expect(second.result.current).toBe(true);
    first.unmount();
    second.unmount();
    expect(after.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('is false on a desktop device even at phone width', () => {
    const media = installMatchMedia(true);
    const original = window.__EX_FORCE_DEVICE__;
    window.__EX_FORCE_DEVICE__ = 'desktop';
    try {
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);
      act(() => media.emit(true));
      expect(result.current).toBe(false);
    } finally {
      window.__EX_FORCE_DEVICE__ = original;
    }
  });
});
