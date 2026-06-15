import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockNative = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockPlugin: any = null;
vi.mock('./capacitor', () => ({
  isNativePlatform: () => mockNative,
  getCapacitorPlugin: () => mockPlugin,
}));

import { triggerMessageActionHaptic } from './haptics';

function setVibrate(fn: ((p: number) => boolean) | undefined) {
  Object.defineProperty(navigator, 'vibrate', { value: fn, configurable: true, writable: true });
}

describe('triggerMessageActionHaptic', () => {
  beforeEach(() => {
    mockNative = false;
    mockPlugin = null;
  });
  afterEach(() => {
    setVibrate(undefined);
  });

  it('uses native Haptics.impact when available', () => {
    mockNative = true;
    const impact = vi.fn().mockResolvedValue(undefined);
    mockPlugin = { impact };
    triggerMessageActionHaptic();
    expect(impact).toHaveBeenCalledWith({ style: 'MEDIUM' });
  });

  it('falls back to navigator.vibrate when the native plugin is missing', () => {
    mockNative = true;
    mockPlugin = null;
    const vibrate = vi.fn();
    setVibrate(vibrate);
    triggerMessageActionHaptic();
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it('uses navigator.vibrate on web', () => {
    const vibrate = vi.fn();
    setVibrate(vibrate);
    triggerMessageActionHaptic();
    expect(vibrate).toHaveBeenCalledWith(10);
  });

  it('no-ops when neither native haptics nor vibrate are available', () => {
    setVibrate(undefined);
    expect(() => triggerMessageActionHaptic()).not.toThrow();
  });
});
