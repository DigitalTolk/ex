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

function makeOsc(): FakeOsc {
  const osc: FakeOsc = {
    type: '',
    frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(() => gainSink),
    start: vi.fn(),
    stop: vi.fn(),
  };
  return osc;
}

let gainSink: FakeGain;

describe('playNotificationPing', () => {
  let resumeMock: ReturnType<typeof vi.fn>;
  let createOsc: ReturnType<typeof vi.fn>;
  let createGain: ReturnType<typeof vi.fn>;
  let originalAudioContext: typeof AudioContext | undefined;

  async function loadModule() {
    vi.resetModules();
    const mod = await import('@/lib/notification-sound');
    return mod.playNotificationPing;
  }

  beforeEach(() => {
    resumeMock = vi.fn().mockResolvedValue(undefined);
    gainSink = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
    createOsc = vi.fn().mockImplementation(makeOsc);
    createGain = vi.fn().mockImplementation(() => gainSink);

    const Ctor = vi.fn(function FakeAudioContext(this: Record<string, unknown>) {
      this.currentTime = 0;
      this.state = 'suspended';
      this.destination = {};
      this.resume = resumeMock;
      this.createOscillator = createOsc;
      this.createGain = createGain;
    });
    originalAudioContext = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    Object.defineProperty(window, 'AudioContext', { value: Ctor, configurable: true, writable: true });
  });

  afterEach(() => {
    if (originalAudioContext) {
      Object.defineProperty(window, 'AudioContext', { value: originalAudioContext, configurable: true });
    }
  });

  it('creates an oscillator and starts/stops it on each call (after first init)', async () => {
    const play = await loadModule();
    play();
    expect(createOsc).toHaveBeenCalledTimes(1);
    expect(createGain).toHaveBeenCalledTimes(1);
    expect(resumeMock).toHaveBeenCalled();

    const osc = createOsc.mock.results[0].value as FakeOsc;
    expect(osc.type).toBe('sine');
    expect(osc.start).toHaveBeenCalledTimes(1);
    expect(osc.stop).toHaveBeenCalledTimes(1);
  });

  it('reuses the cached AudioContext on subsequent calls', async () => {
    const play = await loadModule();
    play();
    play();
    const Ctor = (window as unknown as { AudioContext: ReturnType<typeof vi.fn> }).AudioContext;
    expect(Ctor).toHaveBeenCalledTimes(1);
    // Each call still creates a fresh oscillator.
    expect(createOsc).toHaveBeenCalledTimes(2);
  });
});
