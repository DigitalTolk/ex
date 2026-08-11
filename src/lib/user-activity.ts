// Attention model (SPEC.md §2): decides whether a human is demonstrably at
// THIS device right now. It is the desktop-presence signal for the
// notification ack (NotificationContext): the backend defers each mobile push
// until the desktop acks — but an ack from an open-yet-abandoned (or locked,
// or just-woken) laptop stood the phone down while nobody was at the desk.
//
// "Attentive" = page visible AND window focused AND real input recently AND
// no hard-away signal. Everything else withholds the ack so the mobile
// fallback fires (Slack behavior). Erring toward "away" is the safe
// direction — worst case is a duplicate alert, never a lost one.
//
// Rules (SPEC §2, normative):
//   R1 — only REAL input advances the activity clock. focus/visibilitychange
//        must NOT stamp: OS unlock auto-restores focus with zero human proof
//        (that stamping was GAP-6, a real away-detection hole).
//   R2 — hard-away signals (screen lock / suspend / OS idle, fed by the
//        desktop shell bridge or the Chromium IdleDetector) force AWAY
//        immediately, regardless of the input clock.
//   R3 — waking from sleep (detected here as a timer gap) forces AWAY until
//        the next real input, so a machine waking up never retro-acks alerts
//        that arrived while it slept.

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

// Attention windows (SPEC §8). The ack tier is how recently input must have
// been seen for the desktop to claim an alert; the suppression tier gates
// surfacing NOTHING at all (you're looking right at the parent), which is the
// highest-risk action and therefore demands the freshest proof (R5).
// I-11 lattice (pinned by attention-constants.test.ts):
//   suppressionWindowMs <= attentionWindowMs.
export const attentionWindowMs = 10 * 60_000;
export const suppressionWindowMs = 2 * 60_000;

// Wake detection (R3): a probe ticks every wakeProbeIntervalMs; a gap larger
// than the interval + clockJumpMs means the timer was frozen — system sleep,
// a frozen tab, or a suspended VM — so the user was not at THIS page.
export const wakeProbeIntervalMs = 5_000;
export const clockJumpMs = 30_000;

let lastActivityAt = Date.now();
let tracking = false;
let focused = true;
let awayUntilInput = false;
let lastWakeProbeAt = 0;
let wakeTimer: number | undefined;
const hardAwayReasons = new Set<string>();

// activityBroadcast forwards each activity stamp to the cross-tab
// coordinator (tab-leader), which throttles and shares it so OTHER tabs can
// factor this tab's activity into whole-device away decisions. Nullable seam
// — nothing is forwarded until the coordinator registers.
let activityBroadcast: ((at: number) => void) | null = null;

// attentionBroadcast fires on binary attention flips (hard-away set/cleared,
// wake detected, focus change) so the coordinator can re-broadcast this tab's
// snapshot immediately instead of waiting for the next input stamp.
let attentionBroadcast: (() => void) | null = null;

export function setActivityBroadcast(cb: ((at: number) => void) | null): void {
  activityBroadcast = cb;
}

export function setAttentionBroadcast(cb: (() => void) | null): void {
  attentionBroadcast = cb;
}

// markUserActivity stamps the activity clock directly — for the desktop-shell
// presence bridge (OS-level input the page can't see) and tests. Real input
// evidence, so it also clears the wake latch (R3).
export function markUserActivity(at: number = Date.now()): void {
  lastActivityAt = at;
  awayUntilInput = false;
  activityBroadcast?.(at);
}

function stamp(): void {
  markUserActivity(Date.now());
}

function onFocus(): void {
  focused = true;
  // NOT an input stamp (R1) — but siblings must learn the focus flip now.
  attentionBroadcast?.();
}

function onBlur(): void {
  focused = false;
  attentionBroadcast?.();
}

// setHardAway registers/clears a named hard-away signal (R2). Sources today:
// 'shell' (ex-electron powerMonitor bridge: locked / suspended / OS-idle) and
// 'idle-detector' (Chromium IdleDetector: screen locked or user idle).
export function setHardAway(reason: string, on: boolean): void {
  const before = hardAwayReasons.size > 0;
  if (on) {
    hardAwayReasons.add(reason);
  } else {
    hardAwayReasons.delete(reason);
  }
  if (before !== hardAwayReasons.size > 0) attentionBroadcast?.();
}

// forceAwayUntilInput latches AWAY until the next real input (R3) — the wake
// path. Exported for the shell bridge (system resume) and tests.
export function forceAwayUntilInput(): void {
  if (awayUntilInput) return;
  awayUntilInput = true;
  attentionBroadcast?.();
}

// isHardAway: any hard-away signal, including the wake latch. Shared with the
// cross-tab snapshot so a locked device is away in EVERY tab's ledger.
export function isHardAway(): boolean {
  return awayUntilInput || hardAwayReasons.size > 0;
}

export function isWindowFocused(): boolean {
  return focused;
}

function wakeProbe(): void {
  const now = Date.now();
  // First tick after install initialises the baseline.
  if (lastWakeProbeAt !== 0 && now - lastWakeProbeAt > wakeProbeIntervalMs + clockJumpMs) {
    forceAwayUntilInput();
  }
  lastWakeProbeAt = now;
}

// startUserActivityTracking installs the document-level listeners once.
// Capture phase so editors/overlays that stop propagation still count;
// passive so the pointermove firehose can't block scrolling.
export function startUserActivityTracking(): void {
  if (tracking) return;
  tracking = true;
  focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
  for (const evt of ACTIVITY_EVENTS) {
    document.addEventListener(evt, stamp, { capture: true, passive: true });
  }
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  lastWakeProbeAt = Date.now();
  wakeTimer = window.setInterval(wakeProbe, wakeProbeIntervalMs);
}

// isUserAttentive reports whether a human is demonstrably at this device: the
// page is visible, the window has OS focus, no hard-away signal is latched,
// and real input was seen within the window. A hidden page or a blurred
// window is never attentive (other tab, other app, minimized, screen locked).
export function isUserAttentive(withinMs: number): boolean {
  if (document.visibilityState !== 'visible') return false;
  if (!focused) return false;
  if (isHardAway()) return false;
  return Date.now() - lastActivityAt <= withinMs;
}

// resetUserActivityForTests restores the module baseline AND tears the
// listeners + wake-probe interval down. Full teardown matters: a pending
// interval firing during a test file's environment teardown is exactly the
// timer-leak class that has crashed vitest teardown before — test files that
// mount NotificationProvider must call this in afterEach.
export function resetUserActivityForTests(): void {
  if (tracking) {
    for (const evt of ACTIVITY_EVENTS) {
      document.removeEventListener(evt, stamp, { capture: true });
    }
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    window.clearInterval(wakeTimer);
    wakeTimer = undefined;
    tracking = false;
  }
  lastActivityAt = Date.now();
  focused = true;
  awayUntilInput = false;
  lastWakeProbeAt = 0;
  hardAwayReasons.clear();
  activityBroadcast = null;
  attentionBroadcast = null;
}
