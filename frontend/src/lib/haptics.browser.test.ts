import { describe, it, expect, vi, beforeEach } from 'vitest';

// Browser-gate coverage for the message-action haptic (native plugin path +
// web vibrate fallback). Only a jsdom test existed previously.

const native = vi.hoisted(() => ({ value: false }));
const plugin = vi.hoisted(() => ({ value: null as { impact?: (o?: unknown) => Promise<void> } | null }));
vi.mock('./capacitor', () => ({
  isNativePlatform: () => native.value,
  getCapacitorPlugin: () => plugin.value,
}));

import { triggerMessageActionHaptic } from './haptics';

beforeEach(() => {
  native.value = false;
  plugin.value = null;
});

function withVibrate(fn: (vibrate: ReturnType<typeof vi.fn>) => void) {
  const vibrate = vi.fn();
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'vibrate')
    ?? Object.getOwnPropertyDescriptor(navigator, 'vibrate');
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: vibrate });
  try {
    fn(vibrate);
  } finally {
    if (original) Object.defineProperty(navigator, 'vibrate', original);
  }
}

describe('triggerMessageActionHaptic (browser)', () => {
  it('uses the native Haptics plugin on a native platform', () => {
    native.value = true;
    const impact = vi.fn().mockResolvedValue(undefined);
    plugin.value = { impact };
    triggerMessageActionHaptic();
    expect(impact).toHaveBeenCalledWith({ style: 'MEDIUM' });
  });

  it('falls back to navigator.vibrate on the web', () => {
    native.value = false;
    withVibrate((vibrate) => {
      triggerMessageActionHaptic();
      expect(vibrate).toHaveBeenCalledWith(10);
    });
  });

  it('swallows a rejected native impact (haptics are best-effort)', async () => {
    native.value = true;
    const impact = vi.fn().mockRejectedValue(new Error('bridge gone'));
    plugin.value = { impact };
    triggerMessageActionHaptic();
    expect(impact).toHaveBeenCalledWith({ style: 'MEDIUM' });
    // Flush the rejection through the .catch(() => {}) arm — an unhandled
    // rejection here would fail the run.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('on native but with no Haptics plugin, falls through to vibrate', () => {
    native.value = true;
    plugin.value = null;
    withVibrate((vibrate) => {
      triggerMessageActionHaptic();
      expect(vibrate).toHaveBeenCalledWith(10);
    });
  });
});
