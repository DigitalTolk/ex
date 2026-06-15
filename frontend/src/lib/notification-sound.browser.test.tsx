import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

// Browser-gate coverage for the Web Audio "ping". The module keeps a single
// process-wide AudioContext (`ctx`) that vi.resetModules() does NOT reset in
// browser mode — once a context exists it is reused across tests. So rather
// than fighting the singleton, these tests install ONE controllable fake
// context whose latest instance is captured, then mutate that instance's
// `state` to walk every resumeThenMaybePlay branch (running / suspended /
// closed) within the same module lifetime.

function makeNode() {
  return {
    type: '',
    frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    connect(n: unknown) { return n; },
    start() {},
    stop() {},
  };
}

interface Live {
  state: string;
  resumeCalls: number;
  settleResume: (() => void) | null;
}

let live: Live | null = null;
let resumeMode: 'sync' | 'deferred' = 'sync';

class ControllableAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  resumeCalls = 0;
  settleResume: (() => void) | null = null;
  constructor() {
    this.state = 'running';
    // Expose the just-constructed instance so tests can mutate its state to
    // walk the module's running/suspended/closed branches.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    live = this;
  }
  createOscillator() { return makeNode(); }
  createGain() { return makeNode(); }
  resume() {
    this.resumeCalls++;
    if (resumeMode === 'sync') {
      this.state = 'running';
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      this.settleResume = () => { this.state = 'running'; res(); };
    });
  }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

let mod: typeof import('./notification-sound');
const win = window as Window & { AudioContext?: unknown; webkitAudioContext?: unknown };
let originalAudioContext: unknown;

beforeEach(async () => {
  resumeMode = 'sync';
  originalAudioContext = win.AudioContext;
  win.AudioContext = ControllableAudioContext as unknown as typeof AudioContext;
  mod = await import('./notification-sound');
  // Make sure the singleton context exists and is the controllable fake. A
  // gesture unlocks it (ensureContext + resumeThenMaybePlay on a running ctx).
  window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  if (live) { live.state = 'running'; live.resumeCalls = 0; }
});

describe('notification-sound', () => {
  it('schedules a tone directly when the context is already running', () => {
    // c.state === 'running' in playNotificationPing → scheduleTone runs
    // straight away (no pending queue).
    expect(() => mod.playNotificationPing()).not.toThrow();
  });

  it('queues a pending ping on a suspended context and flushes it once resume settles', async () => {
    // Force the live singleton suspended and make resume() deferred so the
    // pending-queue path is observable.
    resumeMode = 'deferred';
    if (!live) throw new Error('no live context');
    live.state = 'suspended';
    live.resumeCalls = 0;
    // playNotificationPing: state !== running → pendingPing = true,
    // resumeThenMaybePlay → suspended branch → !resumeInFlight → resume().
    mod.playNotificationPing();
    // A second ping while resume is in flight finds resumeInFlight truthy and
    // does not start a second resume.
    mod.playNotificationPing();
    expect(live.resumeCalls).toBe(1);
    // Settle resume() → schedulePendingTone runs with pendingPing true,
    // scheduling the queued tone.
    live.settleResume?.();
    await vi.waitFor(() => expect(live?.state).toBe('running'));
  });

  it('recreates the context when the live one is closed', () => {
    // resumeThenMaybePlay sees state 'closed' → nulls ctx, ensureContext()
    // builds a fresh (running) context, and recursion schedules on it.
    if (!live) throw new Error('no live context');
    live.state = 'closed';
    expect(() => mod.playNotificationPing()).not.toThrow();
    // A brand-new live instance was constructed and is running.
    expect(live.state).toBe('running');
  });

  it('is a no-op when no AudioContext constructor is available', () => {
    // Remove the constructor so ensureContext returns null; but the singleton
    // already exists and is closed → ensureContext rebuild path returns null.
    if (!live) throw new Error('no live context');
    live.state = 'closed';
    const saved = win.AudioContext;
    const savedWebkit = win.webkitAudioContext;
    delete win.AudioContext;
    delete win.webkitAudioContext;
    try {
      // ctx is closed → ensureContext nulls ctx then finds no Ctor → null.
      expect(() => mod.playNotificationPing()).not.toThrow();
      // A gesture with no Ctor hits unlockAudioContext's `if (!c) return`.
      expect(() => window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))).not.toThrow();
    } finally {
      win.AudioContext = saved;
      if (savedWebkit !== undefined) win.webkitAudioContext = savedWebkit;
    }
  });
});

describe('notification-sound webkit fallback', () => {
  it('falls back to webkitAudioContext when the standard constructor is missing', () => {
    // Force the existing singleton closed so ensureContext rebuilds, then
    // expose only webkitAudioContext: the `AudioContext || webkitAudioContext`
    // expression takes the right-hand side.
    if (!live) throw new Error('no live context');
    live.state = 'closed';
    const saved = win.AudioContext;
    delete win.AudioContext;
    win.webkitAudioContext = ControllableAudioContext as unknown as typeof AudioContext;
    try {
      expect(() => mod.playNotificationPing()).not.toThrow();
      expect(live?.state).toBe('running');
    } finally {
      win.AudioContext = saved;
      delete win.webkitAudioContext;
    }
  });
});

describe('notification-sound — no global AudioContext at all', () => {
  it('playNotificationPing is a no-op when the singleton is closed and no Ctor exists', () => {
    // This restores the standard guard test without depending on a fresh
    // module: close the live ctx and strip constructors.
    if (live) live.state = 'closed';
    const saved = win.AudioContext;
    const savedWebkit = win.webkitAudioContext;
    delete win.AudioContext;
    delete win.webkitAudioContext;
    try {
      expect(() => mod.playNotificationPing()).not.toThrow();
    } finally {
      win.AudioContext = saved;
      if (savedWebkit !== undefined) win.webkitAudioContext = savedWebkit;
    }
  });
});

afterAll(() => {
  // Restore the real AudioContext so the fake does not leak into other test
  // files that share the Playwright worker.
  if (originalAudioContext !== undefined) win.AudioContext = originalAudioContext;
  else delete win.AudioContext;
});
