import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useZoomWheel } from './useZoomWheel';

describe('useZoomWheel', () => {
  it('claims only Ctrl/⌘ + wheel, and lets go when the element goes', () => {
    const onZoom = vi.fn();
    const { result } = renderHook(() => useZoomWheel(onZoom));
    const el = document.createElement('div');
    const cleanup = result.current(el)!;

    const plain = new WheelEvent('wheel', { deltaY: -10, cancelable: true });
    el.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(onZoom).not.toHaveBeenCalled();

    const zoom = new WheelEvent('wheel', { deltaY: -10, ctrlKey: true, cancelable: true });
    el.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);
    expect(onZoom).toHaveBeenCalledWith(zoom);

    cleanup();
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, metaKey: true, cancelable: true }));
    expect(onZoom).toHaveBeenCalledTimes(1);
    // React hands a ref callback null when its element goes.
    expect(result.current(null)).toBeUndefined();
  });
});
