// Approval-chime coverage for lib/notification-sound: the two-note rising
// chime (scheduleApprovalTone), the approval arm of scheduleTone, and the
// webkitAudioContext constructor fallback. The message-ping paths live in
// notification-sound.test.ts; this file reuses its fake-AudioContext shape.
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

describe('playApprovalChime', () => {
  let resumeMock: ReturnType<typeof vi.fn>;
  let createOsc: ReturnType<typeof vi.fn>;
  let createGain: ReturnType<typeof vi.fn>;
  let originalAudioContext: typeof AudioContext | undefined;
  let initialState: AudioContextState;

  async function loadModule() {
    vi.resetModules();
    const mod = await import('@/lib/notification-sound');
    return mod;
  }

  function makeCtor() {
    return vi.fn(function FakeAudioContext(this: Record<string, unknown>) {
      this.currentTime = 0;
      this.state = initialState;
      this.destination = {};
      this.resume = resumeMock;
      this.createOscillator = createOsc;
      this.createGain = createGain;
    });
  }

  function installFakeAudioContext() {
    originalAudioContext = (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    Object.defineProperty(window, 'AudioContext', { value: makeCtor(), configurable: true, writable: true });
  }

  beforeEach(() => {
    resumeMock = vi.fn().mockResolvedValue(undefined);
    gainSink = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    };
    createOsc = vi.fn().mockImplementation(makeOsc);
    createGain = vi.fn().mockImplementation(() => gainSink);
    initialState = 'running';
    installFakeAudioContext();
  });

  afterEach(() => {
    if (originalAudioContext) {
      Object.defineProperty(window, 'AudioContext', { value: originalAudioContext, configurable: true });
    }
    delete (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  });

  it('schedules the two-note rising chime (G5 → C6) on a running context', async () => {
    const { playApprovalChime } = await loadModule();
    playApprovalChime();

    // Two pulses — that rhythm is what distinguishes the approval chime
    // from the single message ping.
    expect(createOsc).toHaveBeenCalledTimes(2);
    const first = createOsc.mock.results[0].value as FakeOsc;
    const second = createOsc.mock.results[1].value as FakeOsc;
    expect(first.type).toBe('sine');
    expect(second.type).toBe('sine');
    expect(first.frequency.setValueAtTime).toHaveBeenCalledWith(784, 0);
    expect(second.frequency.setValueAtTime).toHaveBeenCalledWith(1046, 0.16);
    expect(first.start).toHaveBeenCalledWith(0);
    expect(first.stop).toHaveBeenCalledWith(0.22);
    expect(second.start).toHaveBeenCalledWith(0.16);
    expect(second.stop).toHaveBeenCalledWith(0.16 + 0.22);
    // Envelope rides each note: 0.0001 → 0.18 → 0.0001.
    expect(gainSink.gain.setValueAtTime).toHaveBeenCalledWith(0.0001, 0);
    expect(gainSink.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.18, 0.015);
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it('keeps the APPROVAL shape for a chime queued behind a suspended context', async () => {
    // The pending-tone slot carries the KIND: an approval queued before the
    // first user gesture must not play back as a message ping.
    let resolveResume: () => void = () => undefined;
    resumeMock = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveResume = res;
        }),
    );
    initialState = 'suspended';
    installFakeAudioContext();

    const { playApprovalChime } = await loadModule();
    playApprovalChime();

    expect(resumeMock).toHaveBeenCalledTimes(1);
    expect(createOsc).not.toHaveBeenCalled();

    resolveResume();
    await Promise.resolve();
    await Promise.resolve();

    expect(createOsc).toHaveBeenCalledTimes(2);
    const first = createOsc.mock.results[0].value as FakeOsc;
    expect(first.frequency.setValueAtTime).toHaveBeenCalledWith(784, 0);
  });

  it('falls back to webkitAudioContext when the unprefixed constructor is missing', async () => {
    // Older Safari exposes only the prefixed constructor.
    Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true, writable: true });
    Object.defineProperty(window, 'webkitAudioContext', { value: makeCtor(), configurable: true, writable: true });

    const { playApprovalChime } = await loadModule();
    playApprovalChime();

    expect(createOsc).toHaveBeenCalledTimes(2);
    const Ctor = (window as unknown as { webkitAudioContext: ReturnType<typeof vi.fn> }).webkitAudioContext;
    expect(Ctor).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no AudioContext constructor exists at all', async () => {
    Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true, writable: true });
    const { playApprovalChime } = await loadModule();
    expect(() => playApprovalChime()).not.toThrow();
    expect(createOsc).not.toHaveBeenCalled();
  });

  it('coalesces concurrent resume attempts into one resume() call', async () => {
    let resolveResume: () => void = () => undefined;
    resumeMock = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveResume = res;
        }),
    );
    initialState = 'suspended';
    installFakeAudioContext();

    const { playApprovalChime, playNotificationPing } = await loadModule();
    playApprovalChime();
    // A second alert while resume() is still in flight must not start a
    // second resume -- the freshest tone simply replaces the queued one.
    playNotificationPing();
    expect(resumeMock).toHaveBeenCalledTimes(1);

    resolveResume();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The queued tone was overwritten to 'message': a single soft ping,
    // not the two-note chime.
    expect(createOsc).toHaveBeenCalledTimes(1);
    const osc = createOsc.mock.results[0].value as FakeOsc;
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(660, 0);
  });

});
