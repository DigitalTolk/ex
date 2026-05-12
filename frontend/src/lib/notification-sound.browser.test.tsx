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
});
