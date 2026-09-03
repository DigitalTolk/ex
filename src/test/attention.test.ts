import { describe, it, expect, vi, afterEach } from 'vitest';
import { hasAttentionBridge, requestOsAttention } from '@/lib/attention';

type BridgeWindow = Window & { __EX_ATTENTION__?: () => void };

function installBridge(fn: () => void) {
  Object.defineProperty(window, '__EX_ATTENTION__', { value: fn, configurable: true, writable: true });
}

afterEach(() => {
  delete (window as BridgeWindow).__EX_ATTENTION__;
});

describe('hasAttentionBridge', () => {
  it('is false in a plain browser tab (no shell bridge)', () => {
    delete (window as BridgeWindow).__EX_ATTENTION__;
    expect(hasAttentionBridge()).toBe(false);
  });

  it('is false when the global is present but not callable', () => {
    Object.defineProperty(window, '__EX_ATTENTION__', { value: 'nope', configurable: true, writable: true });
    expect(hasAttentionBridge()).toBe(false);
  });

  it('is true when the desktop shell exposes the bridge', () => {
    installBridge(() => {});
    expect(hasAttentionBridge()).toBe(true);
  });
});

describe('requestOsAttention', () => {
  it('is a silent no-op without the bridge', () => {
    delete (window as BridgeWindow).__EX_ATTENTION__;
    expect(() => requestOsAttention()).not.toThrow();
  });

  it('ignores a non-callable bridge value', () => {
    Object.defineProperty(window, '__EX_ATTENTION__', { value: 42, configurable: true, writable: true });
    expect(() => requestOsAttention()).not.toThrow();
  });

  it('invokes the bridge when present', () => {
    const ask = vi.fn();
    installBridge(ask);
    requestOsAttention();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing shell — the alert itself must still deliver', () => {
    installBridge(() => {
      throw new Error('shell exploded');
    });
    expect(() => requestOsAttention()).not.toThrow();
  });
});
