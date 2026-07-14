import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  idleDetectionSupported,
  idleDetectorThresholdMs,
  requestIdleDetectionPermission,
  startIdleDetection,
  stopIdleDetection,
} from './idle-detector';
import { isHardAway, resetUserActivityForTests } from './user-activity';

class FakeIdleDetector {
  static permissionResult: 'granted' | 'denied' = 'granted';
  static permissionThrows = false;
  static startThrows = false;
  static pendingStart = false;
  static rejectPendingStart: ((err: Error) => void) | null = null;
  static instances: FakeIdleDetector[] = [];

  userState: 'active' | 'idle' | null = 'active';
  screenState: 'locked' | 'unlocked' | null = 'unlocked';
  changeCb: (() => void) | null = null;
  startedWith: { threshold: number; signal?: AbortSignal } | null = null;

  constructor() {
    FakeIdleDetector.instances.push(this);
  }

  addEventListener(_type: 'change', cb: () => void): void {
    this.changeCb = cb;
  }

  async start(opts: { threshold: number; signal?: AbortSignal }): Promise<void> {
    if (FakeIdleDetector.startThrows) throw new Error('NotAllowedError');
    if (FakeIdleDetector.pendingStart) {
      return new Promise((_resolve, reject) => {
        FakeIdleDetector.rejectPendingStart = reject;
      });
    }
    this.startedWith = opts;
  }

  static async requestPermission(): Promise<'granted' | 'denied'> {
    if (FakeIdleDetector.permissionThrows) throw new Error('gesture required');
    return FakeIdleDetector.permissionResult;
  }

  fire(userState: 'active' | 'idle', screenState: 'locked' | 'unlocked'): void {
    this.userState = userState;
    this.screenState = screenState;
    this.changeCb?.();
  }
}

function installFake(): void {
  (globalThis as { IdleDetector?: unknown }).IdleDetector = FakeIdleDetector;
}

function removeFake(): void {
  delete (globalThis as { IdleDetector?: unknown }).IdleDetector;
}

describe('idle-detector', () => {
  beforeEach(() => {
    resetUserActivityForTests();
    FakeIdleDetector.permissionResult = 'granted';
    FakeIdleDetector.permissionThrows = false;
    FakeIdleDetector.startThrows = false;
    FakeIdleDetector.pendingStart = false;
    FakeIdleDetector.rejectPendingStart = null;
    FakeIdleDetector.instances = [];
  });

  afterEach(() => {
    stopIdleDetection();
    removeFake();
    resetUserActivityForTests();
  });

  it('reports unsupported (and declines everything) without the API', async () => {
    expect(idleDetectionSupported()).toBe(false);
    expect(await requestIdleDetectionPermission()).toBe(false);
    expect(await startIdleDetection()).toBe(false);
  });

  it('requests permission through the API, mapping denied and throws to false', async () => {
    installFake();
    expect(idleDetectionSupported()).toBe(true);
    expect(await requestIdleDetectionPermission()).toBe(true);
    FakeIdleDetector.permissionResult = 'denied';
    expect(await requestIdleDetectionPermission()).toBe(false);
    FakeIdleDetector.permissionThrows = true;
    expect(await requestIdleDetectionPermission()).toBe(false);
  });

  it('latches hard-away on OS idle or screen lock, and releases on active+unlocked (R2)', async () => {
    installFake();
    expect(await startIdleDetection()).toBe(true);
    const det = FakeIdleDetector.instances[0];
    expect(det.startedWith?.threshold).toBe(idleDetectorThresholdMs);
    expect(isHardAway()).toBe(false);

    det.fire('idle', 'unlocked');
    expect(isHardAway()).toBe(true);
    det.fire('active', 'unlocked');
    expect(isHardAway()).toBe(false);
    det.fire('active', 'locked');
    expect(isHardAway()).toBe(true);
    det.fire('active', 'unlocked');
    expect(isHardAway()).toBe(false);
  });

  it('is idempotent while running (a second start does not spawn a second detector)', async () => {
    installFake();
    expect(await startIdleDetection()).toBe(true);
    expect(await startIdleDetection()).toBe(true);
    expect(FakeIdleDetector.instances).toHaveLength(1);
  });

  it('stop releases a latched hard-away so a stale lock flag cannot outlive the opt-out', async () => {
    installFake();
    await startIdleDetection();
    FakeIdleDetector.instances[0].fire('idle', 'locked');
    expect(isHardAway()).toBe(true);
    stopIdleDetection();
    expect(isHardAway()).toBe(false);
    // Stopped — a new start spawns a fresh detector (the old abort is gone).
    expect(await startIdleDetection()).toBe(true);
    expect(FakeIdleDetector.instances).toHaveLength(2);
  });

  it('stopping during a pending start leaves the stopped state authoritative when the start later rejects', async () => {
    installFake();
    FakeIdleDetector.pendingStart = true;
    const starting = startIdleDetection();
    // The user opts out while start() is still settling: stop clears the
    // running latch, and the aborted start's rejection must not resurrect it.
    stopIdleDetection();
    FakeIdleDetector.rejectPendingStart?.(new Error('aborted'));
    expect(await starting).toBe(false);
    expect(isHardAway()).toBe(false);
    // A fresh start still works afterwards.
    FakeIdleDetector.pendingStart = false;
    expect(await startIdleDetection()).toBe(true);
  });

  it('a start() rejection (permission never granted) reads as false and leaves no hard-away', async () => {
    installFake();
    FakeIdleDetector.startThrows = true;
    expect(await startIdleDetection()).toBe(false);
    expect(isHardAway()).toBe(false);
    // And the failed attempt did not wedge the "already running" latch.
    FakeIdleDetector.startThrows = false;
    expect(await startIdleDetection()).toBe(true);
  });
});
