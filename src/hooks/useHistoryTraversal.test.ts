import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useHistoryTraversal } from './useHistoryTraversal';

// jsdom has no Navigation API; a stand-in reports what the browser would.
class FakeNavigation extends EventTarget {
  canGoBack = false;
  canGoForward = false;
  move(back: boolean, forward: boolean) {
    this.canGoBack = back;
    this.canGoForward = forward;
    this.dispatchEvent(new Event('currententrychange'));
  }
}

function installNavigation(): FakeNavigation {
  const nav = new FakeNavigation();
  Object.defineProperty(window, 'navigation', { value: nav, configurable: true });
  return nav;
}

afterEach(() => {
  Reflect.deleteProperty(window, 'navigation');
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

  it('stops listening when unmounted', () => {
    const nav = installNavigation();
    const remove = vi.spyOn(nav, 'removeEventListener');
    const { unmount } = renderHook(() => useHistoryTraversal());
    unmount();
    expect(remove).toHaveBeenCalledWith('currententrychange', expect.any(Function));
  });

  it('reports nothing where the browser has no Navigation API', () => {
    const { result, unmount } = renderHook(() => useHistoryTraversal());
    expect(result.current).toEqual({ supported: false, canGoBack: false, canGoForward: false });
    unmount();
  });
});
