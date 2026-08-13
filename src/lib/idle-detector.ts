// Chromium IdleDetector layer (SPEC §2 R6, layer 2): OS-level user-idle and
// screen-lock detection for the plain browser, where the page alone is blind
// to lock/screensaver. Chromium-only (Firefox/Safari rejected the API on
// privacy grounds) and permission-gated behind a user gesture, so this is an
// OPT-IN enhancement — absence changes nothing (the web floor governs).

import { setHardAway } from '@/lib/user-activity';

// The Idle Detection API types aren't in TS's DOM lib yet.
interface IdleDetectorLike {
  userState: 'active' | 'idle' | null;
  screenState: 'locked' | 'unlocked' | null;
  addEventListener(type: 'change', cb: () => void): void;
  start(opts: { threshold: number; signal?: AbortSignal }): Promise<void>;
}
interface IdleDetectorCtor {
  new (): IdleDetectorLike;
  requestPermission(): Promise<'granted' | 'denied'>;
}

// Matches the shell's OS-idle threshold (Mattermost's value): 60s without
// OS-level input ⇒ not at the desktop. Also the API's minimum.
export const idleDetectorThresholdMs = 60_000;

const HARD_AWAY_REASON = 'idle-detector';

let abort: AbortController | null = null;

function detectorCtor(): IdleDetectorCtor | null {
  const ctor = (globalThis as { IdleDetector?: IdleDetectorCtor }).IdleDetector;
  return ctor ?? null;
}

export function idleDetectionSupported(): boolean {
  return detectorCtor() !== null;
}

// requestIdleDetectionPermission must be called from a user gesture (the
// settings toggle click). Denied/unsupported/throwing all read as false.
export async function requestIdleDetectionPermission(): Promise<boolean> {
  const ctor = detectorCtor();
  if (!ctor) return false;
  try {
    return (await ctor.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

// startIdleDetection begins observing; idempotent while running. Only a
// LOCKED screen latches the hard-away flag (R2): lock is definitive "not at
// this device". `userState: 'idle'` (60s without OS input — the API minimum)
// is deliberately NOT hard-away: it is absence of fresh evidence, not proof
// of absence — a user reading goes OS-quiet in 60s while at the desk, and
// latching here buzzed their phone for every alert (same regression as the
// shell bridge's old idle mapping). The ack tier's input window owns the
// idle → phone handoff. Unlock releases the latch. Returns false when the
// API is unavailable, permission wasn't granted, or start() throws — the
// caller falls back to the web floor, never worse off.
export async function startIdleDetection(): Promise<boolean> {
  const ctor = detectorCtor();
  if (!ctor) return false;
  if (abort) return true; // already running
  const controller = new AbortController();
  abort = controller;
  try {
    const detector = new ctor();
    detector.addEventListener('change', () => {
      setHardAway(HARD_AWAY_REASON, detector.screenState === 'locked');
    });
    await detector.start({ threshold: idleDetectorThresholdMs, signal: controller.signal });
    return true;
  } catch {
    if (abort === controller) abort = null;
    setHardAway(HARD_AWAY_REASON, false);
    return false;
  }
}

// stopIdleDetection halts observation and releases any latched hard-away —
// a stale lock flag must not outlive the user turning the feature off.
export function stopIdleDetection(): void {
  abort?.abort();
  abort = null;
  setHardAway(HARD_AWAY_REASON, false);
}
