import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePointerDevice } from './usePointerDevice';
import { POINTER_DEVICE_EVENT, resetPointerDeviceForTests, startLayoutTierTracking } from '@/lib/device';

function reportPointer(connected: boolean) {
  window.__EX_POINTER_DEVICE__ = connected;
  window.dispatchEvent(new CustomEvent(POINTER_DEVICE_EVENT, { detail: { connected } }));
}

describe('usePointerDevice', () => {
  // The input sources are wired where the app boots (main.tsx), so the hook is
  // only live once tier tracking runs.
  let stopTracking = () => {};
  beforeEach(() => {
    stopTracking = startLayoutTierTracking();
  });
  afterEach(() => {
    stopTracking();
    resetPointerDeviceForTests();
  });

  it('is false on a device with no mouse or trackpad', () => {
    const { result } = renderHook(() => usePointerDevice());

    expect(result.current).toBe(false);
  });

  it('re-renders when a trackpad is attached and detached', () => {
    const { result } = renderHook(() => usePointerDevice());

    act(() => reportPointer(true));
    expect(result.current).toBe(true);
    act(() => reportPointer(false));
    expect(result.current).toBe(false);
  });
});
