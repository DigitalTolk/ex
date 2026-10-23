import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHistoryTraversal } from './useHistoryTraversal';
import { installNavigation, uninstallNavigation } from '@/test/fake-navigation';

afterEach(() => {
  uninstallNavigation();
});

describe('useHistoryTraversal', () => {
  it('follows the history as it moves', () => {
    const nav = installNavigation();
    const { result } = renderHook(() => useHistoryTraversal());
    expect(result.current).toEqual({ supported: true, canGoBack: false, canGoForward: false });
    act(() => nav.move(true, false));
    expect(result.current).toEqual({ supported: true, canGoBack: true, canGoForward: false });
    act(() => nav.move(false, true));
    expect(result.current).toEqual({ supported: true, canGoBack: false, canGoForward: true });
  });

  // A back/forward-cache restore announces no currententrychange.
  it('re-reads the history when the page comes back from the back/forward cache', () => {
    const nav = installNavigation();
    const { result } = renderHook(() => useHistoryTraversal());
    nav.canGoBack = true;
    nav.canGoForward = true;
    // An ordinary load is no restore: nothing to re-read.
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    });
    expect(result.current.canGoBack).toBe(false);
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(result.current).toEqual({ supported: true, canGoBack: true, canGoForward: true });
  });

  it('stops listening when unmounted', () => {
    const nav = installNavigation();
    const remove = vi.spyOn(nav, 'removeEventListener');
    const removeFromWindow = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderHook(() => useHistoryTraversal());
    unmount();
    expect(remove).toHaveBeenCalledWith('currententrychange', expect.any(Function));
    expect(removeFromWindow).toHaveBeenCalledWith('pageshow', expect.any(Function));
    removeFromWindow.mockRestore();
  });

  it('reports nothing where the browser has no Navigation API', () => {
    const { result, unmount } = renderHook(() => useHistoryTraversal());
    expect(result.current).toEqual({ supported: false, canGoBack: false, canGoForward: false });
    act(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    expect(result.current.canGoBack).toBe(false);
    unmount();
  });
});
