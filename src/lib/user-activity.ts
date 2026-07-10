// Tracks when the user last interacted with this page. This is the
// desktop-presence signal for the notification ack (NotificationContext): the
// backend defers each mobile push until the desktop acks the notification —
// but an ack from an open-yet-abandoned laptop stood the phone down while
// nobody was at the desk. "Active" = the page is visible AND saw real input
// recently; anything else withholds the ack so the mobile fallback fires
// (Slack behavior: away from the desktop ⇒ the phone buzzes even though the
// desktop app is still running). Erring toward "inactive" is the safe
// direction — worst case is a duplicate alert, never a lost one.

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

let lastActivityAt = Date.now();
let tracking = false;

// activityBroadcast forwards each activity stamp to the cross-tab
// coordinator (tab-leader), which throttles and shares it so OTHER tabs can
// factor this tab's activity into whole-device away decisions. Nullable seam
// — nothing is forwarded until the coordinator registers.
let activityBroadcast: ((at: number) => void) | null = null;

export function setActivityBroadcast(cb: ((at: number) => void) | null): void {
  activityBroadcast = cb;
}

// markUserActivity stamps the activity clock directly — exported for tests
// and for native-shell bridges that can observe input the page can't.
export function markUserActivity(at: number = Date.now()): void {
  lastActivityAt = at;
  activityBroadcast?.(at);
}

function stamp(): void {
  lastActivityAt = Date.now();
  activityBroadcast?.(lastActivityAt);
}

function onVisibilityChange(): void {
  // Switching TO the app is itself an interaction; going hidden needs no
  // stamp — isUserActive already reports inactive while hidden.
  if (document.visibilityState === 'visible') stamp();
}

// startUserActivityTracking installs the document-level listeners once.
// Capture phase so editors/overlays that stop propagation still count;
// passive so the pointermove firehose can't block scrolling.
export function startUserActivityTracking(): void {
  if (tracking) return;
  tracking = true;
  for (const evt of ACTIVITY_EVENTS) {
    document.addEventListener(evt, stamp, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
  // Cmd/Alt-tabbing back to an already-visible window fires only `focus`
  // (no visibilitychange) — returning to the app is an interaction.
  window.addEventListener('focus', stamp);
}

// isUserActive reports whether the user is present at this device: the page
// is visible and input was seen within the window. A hidden page is always
// inactive (other tab, minimized, screen locked).
export function isUserActive(withinMs: number): boolean {
  if (document.visibilityState !== 'visible') return false;
  return Date.now() - lastActivityAt <= withinMs;
}
