import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The phone app builds the AudioContext after launch so the first tap only
// resumes it; everywhere else it is still created by the first gesture.
describe('scheduleAudioPrewarm', () => {
  const win = window as Window & { AudioContext?: unknown };
  let constructed = 0;
  class FakeAudioContext {
    state = 'suspended';
    constructor() {
      constructed++;
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    constructed = 0;
    win.AudioContext = FakeAudioContext;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete win.AudioContext;
    delete window.Capacitor;
  });

  it('creates the context once launch has settled in the phone app, before any tap', async () => {
    window.Capacitor = { isNativePlatform: () => true };
    const mod = await import('./notification-sound');
    expect(constructed).toBe(0);
    vi.advanceTimersByTime(mod.AUDIO_PREWARM_DELAY_MS);
    expect(constructed).toBe(1);
    // The first tap reuses it: only resume() runs inside the gesture.
    window.dispatchEvent(new Event('pointerdown'));
    expect(constructed).toBe(1);
  });

  it('leaves the browser and the desktop app creating it on the first gesture', async () => {
    await import('./notification-sound');
    vi.advanceTimersByTime(10_000);
    expect(constructed).toBe(0);
    window.dispatchEvent(new Event('pointerdown'));
    expect(constructed).toBe(1);
  });
});
