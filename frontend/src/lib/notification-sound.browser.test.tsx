import { describe, expect, it, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('notification-sound — basic guards', () => {
  it('playNotificationPing is a no-op when no AudioContext is available', async () => {
    const win = window as Window & { AudioContext?: unknown; webkitAudioContext?: unknown };
    const original = win.AudioContext;
    const originalWebkit = win.webkitAudioContext;
    delete win.AudioContext;
    delete win.webkitAudioContext;
    try {
      const mod = await import('./notification-sound');
      expect(() => mod.playNotificationPing()).not.toThrow();
    } finally {
      if (original !== undefined) win.AudioContext = original;
      if (originalWebkit !== undefined) win.webkitAudioContext = originalWebkit;
    }
  });

  it('playNotificationPing tolerates being invoked before any user gesture (suspended context)', async () => {
    const mod = await import('./notification-sound');
    // The context will exist (audio APIs are present in chromium) but
    // playNotificationPing should not throw regardless of state.
    expect(() => mod.playNotificationPing()).not.toThrow();
    expect(() => mod.playNotificationPing()).not.toThrow();
  });

  it('drives the running-context path: gesture unlock then a direct tone schedule', async () => {
    const node = () => ({
      type: '',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect(n: unknown) { return n; },
      start() {},
      stop() {},
    });
    class FakeAudioContext {
      state = 'running';
      currentTime = 0;
      destination = {};
      createOscillator() { return node(); }
      createGain() { return node(); }
      resume() { return Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    const win = window as Window & { AudioContext?: unknown };
    const original = win.AudioContext;
    win.AudioContext = FakeAudioContext as unknown as typeof AudioContext;
    try {
      vi.resetModules();
      const mod = await import('./notification-sound');
      // A user gesture fires the unlock listener → ensureContext +
      // resumeThenMaybePlay on a running context → schedulePendingTone with
      // nothing pending (the no-pending early return).
      window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      // With the context already running, the ping schedules the tone
      // directly (exercises scheduleTone end to end).
      expect(() => mod.playNotificationPing()).not.toThrow();
      expect(() => mod.playNotificationPing()).not.toThrow();
    } finally {
      win.AudioContext = original;
    }
  });
});
