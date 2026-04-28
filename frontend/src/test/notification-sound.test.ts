import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeOsc {
  type: string;
  frequency: { setValueAtTime: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

interface FakeGain {
  gain: { setValueAtTime: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
}

let gainSink: FakeGain;

function makeOsc(): FakeOsc {
  return {
    type: '',
    frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(() => gainSink),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe('playNotificationPing', () => {
  let resumeMock: ReturnType<typeof vi.fn>;
  let createOsc: ReturnType<typeof vi.fn>;
  let createGain: ReturnType<typeof vi.fn>;
  let originalAudioContext: typeof AudioContext | undefined;
  let initialState: AudioContextState;

  async function loadModule() {
    vi.resetModules();
    const mod = await import('@/lib/notification-sound');
    return mod.playNotificationPing;
  }

  function installFakeAudioContext() {
    const Ctor = vi.fn(function FakeAudioContext(this: Record<string, unknown>) {
      this.currentTime = 0;
      this.state = initialState;
      this.destination = {};
      this.resume = resumeMock;
      this.createOscillator = createOsc;
      this.createGain = createGain;
    });
    originalAudioContext = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    Object.defineProperty(window, 'AudioContext', { value: Ctor, configurable: true, writable: true });
  }

  beforeEach(() => {
    resumeMock = vi.fn().mockResolvedValue(undefined);
    gainSink = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
    createOsc = vi.fn().mockImplementation(makeOsc);
    createGain = vi.fn().mockImplementation(() => gainSink);
    initialState = 'suspended';
    installFakeAudioContext();
  });

  afterEach(() => {
    if (originalAudioContext) {
      Object.defineProperty(window, 'AudioContext', { value: originalAudioContext, configurable: true });
    }
  });

  it('schedules the tone immediately when the AudioContext is already running', async () => {
    initialState = 'running';
    installFakeAudioContext();
    const play = await loadModule();
    play();
    // Synchronous schedule path — no resume call needed and the oscillator
    // is created on the same tick.
    expect(resumeMock).not.toHaveBeenCalled();
    expect(createOsc).toHaveBeenCalledTimes(1);
    const osc = createOsc.mock.results[0].value as FakeOsc;
    expect(osc.type).toBe('sine');
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(osc.stop).toHaveBeenCalledTimes(1);
  });

  it('defers the tone schedule until resume() resolves on a suspended context', async () => {
    // Regression: previously the tone was scheduled synchronously even
    // when the AudioContext was suspended (browser autoplay policy on
    // Chrome/Safari). The oscillator's start time sat at currentTime=0
    // while the clock was paused, so once the clock resumed the
    // scheduled time was already in the past and no audible ping
    // played. The fix awaits resume() before scheduling.
    let resolveResume: () => void = () => undefined;
    resumeMock = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveResume = res;
        }),
    );
    initialState = 'suspended';
    installFakeAudioContext();

    const play = await loadModule();
    play();

    // Resume requested but not yet resolved → no oscillator yet.
    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(createOsc).not.toHaveBeenCalled();

    // Once the autoplay-policy gate clears, the tone is scheduled.
    resolveResume();
    await Promise.resolve();
    await Promise.resolve();
    expect(createOsc).toHaveBeenCalledTimes(1);
    const osc = createOsc.mock.results[0].value as FakeOsc;
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(osc.stop).toHaveBeenCalledTimes(1);
  });

  it('drops the tone silently when resume() is rejected (denied autoplay)', async () => {
    resumeMock = vi.fn().mockRejectedValue(new Error('autoplay denied'));
    initialState = 'suspended';
    installFakeAudioContext();

    const play = await loadModule();
    play();
    // Wait for the promise rejection to flush. The function must NOT
    // throw and must NOT schedule an oscillator on a still-suspended
    // context.
    await Promise.resolve();
    await Promise.resolve();
    expect(createOsc).not.toHaveBeenCalled();
  });

  it('reuses the cached AudioContext on subsequent calls', async () => {
    initialState = 'running';
    installFakeAudioContext();
    const play = await loadModule();
    play();
    play();
    const Ctor = (window as unknown as { AudioContext: ReturnType<typeof vi.fn> }).AudioContext;
    expect(Ctor).toHaveBeenCalledTimes(1);
    expect(createOsc).toHaveBeenCalledTimes(2);
  });

  it('returns gracefully when AudioContext is unavailable (older browsers / SSR)', async () => {
    Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(
      window,
      'webkitAudioContext',
      { value: undefined, configurable: true, writable: true },
    );
    const play = await loadModule();
    expect(() => play()).not.toThrow();
  });
});

describe('NotificationContext.dispatch — sound regression', () => {
  // Regression coverage: the in-app dispatcher must call playNotificationPing
  // whenever soundEnabled is true. This caught a bug where adding the toast
  // path obscured the sound call site; we want a failing test the moment a
  // future refactor drops the audio cue.
  it('plays the sound on dispatch when soundEnabled is true', async () => {
    const playMock = vi.fn();
    const toastMock = vi.fn();
    vi.resetModules();
    vi.doMock('@/lib/notification-sound', () => ({
      playNotificationPing: () => playMock(),
    }));
    vi.doMock('sonner', () => ({
      toast: (...args: unknown[]) => toastMock(...args),
    }));

    const { NotificationProvider, useNotifications } = await import(
      '@/context/NotificationContext'
    );
    const { render, act } = await import('@testing-library/react');
    const React = await import('react');

    let dispatchRef: ((p: Parameters<ReturnType<typeof useNotifications>['dispatch']>[0]) => void) | null = null;
    function Probe() {
      const { dispatch } = useNotifications();
      React.useEffect(() => {
        dispatchRef = dispatch;
      }, [dispatch]);
      return null;
    }

    render(
      React.createElement(
        NotificationProvider,
        null,
        React.createElement(Probe, null),
      ),
    );

    act(() => {
      dispatchRef!({
        kind: 'message',
        title: 'Alice in ~general',
        body: 'hello',
        deepLink: '/channel/general',
        parentID: 'ch-1',
        parentType: 'channel',
        createdAt: new Date().toISOString(),
      });
    });

    expect(playMock).toHaveBeenCalledTimes(1);
  });
});
