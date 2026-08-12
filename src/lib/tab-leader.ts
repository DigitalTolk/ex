// Cross-tab coordination for notification surfacing (broadcast-channel +
// leader election). The broker fans every `notification.new` out to EVERY
// tab's socket, while activity/visibility are per-tab — that mismatch made
// multi-tab setups break the away contract: an idle hidden tab would surface
// a popup and (via the cross-tab dedup hit in a second tab) ACK it, silently
// cancelling the deferred mobile push while the user was away from all tabs.
//
// The model here:
//   - one elected LEADER tab owns surfacing + acking notifications;
//   - every tab broadcasts a tiny state snapshot {visible, lastActivityAt,
//     activeParent} (throttled) so the leader can decide with WHOLE-DEVICE
//     knowledge: "is the user at the device in ANY tab?", "is any tab
//     actively viewing this conversation?";
//   - non-leader tabs hold a notification briefly and surface it only if
//     they got promoted meanwhile (leader closed) and nobody else did — the
//     localStorage dedup remains the failover belt-and-braces.
//
// Failure direction: no coordinator (init never ran), an election still in
// flight with no other tab known, or a torn channel all behave like the
// single-tab case — dispatch locally. A duplicate popup beats a silent miss.

import { BroadcastChannel, createLeaderElection, type LeaderElector } from 'broadcast-channel';
import { isHardAway, setActivityBroadcast, setAttentionBroadcast } from '@/lib/user-activity';
import { setThreadScopeBroadcast, threadScopeSnapshot } from '@/lib/thread-scope';

interface TabState {
  visible: boolean;
  // OS window focus. A visible-but-blurred tab (second monitor, background
  // window) is NOT proof anyone is at the device — remote checks require it
  // (SPEC GAP-7). Old-version tabs omit it; undefined reads as unfocused,
  // which fails toward "away" (no ack), the safe direction.
  focused: boolean;
  // This tab believes the device is hard-away (screen locked / just woke /
  // OS idle — SPEC §2 R2/R3). A hard-away tab can never vouch for the user.
  hardAway: boolean;
  lastActivityAt: number;
  activeParent: string | null;
  // Thread roots being read in this tab (open panel + /threads cards in
  // view), so the leader can suppress thread-reply alerts device-wide.
  activeThreads: string[];
}

type TabMessage =
  | { kind: 'state'; tabId: string; state: TabState }
  | { kind: 'bye'; tabId: string };

// How long a remote tab's snapshot stays credible without a refresh. Tabs
// re-broadcast on visibility changes and (throttled) on activity; a tab gone
// silent for this long is treated as closed.
const remoteStateTTL = 60_000;

// How often, at most, plain user activity re-broadcasts state. Visibility
// and active-parent changes always broadcast immediately.
const activityBroadcastThrottleMs = 5_000;

// How long a non-leader holds a notification before re-checking whether it
// got promoted (leader tab closed between fan-out and dispatch). Long enough
// for broadcast-channel's election to settle, short enough that a failover
// popup still feels immediate.
export const nonLeaderHoldMs = 1500;

let channel: BroadcastChannel<TabMessage> | null = null;
let elector: LeaderElector | null = null;
let leader = false;
let localActiveParent: string | null = null;
let lastActivityBroadcastAt = 0;
const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
const remote = new Map<string, TabState & { at: number }>();

function postState(): void {
  if (!channel) return;
  const state: TabState = {
    visible: document.visibilityState === 'visible',
    focused: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
    hardAway: isHardAway(),
    lastActivityAt: lastActivityBroadcastAt,
    activeParent: localActiveParent,
    activeThreads: threadScopeSnapshot(),
  };
  try {
    void channel.postMessage({ kind: 'state', tabId, state }).catch(() => {});
  } catch {
    // A torn/closing channel can't coordinate (bc throws synchronously once
    // closed) — the single-tab fallbacks keep notifications flowing.
  }
}

function onVisibilityChange(): void {
  postState();
}

// initTabCoordinator wires the channel, the election, and the state
// broadcasting. Idempotent. `options` passes straight through to
// broadcast-channel — production omits it (auto transport); jsdom tests pass
// {type: 'simulate'} so module + test channels connect in-process.
export function initTabCoordinator(options?: { type?: 'simulate' }): void {
  if (channel) return;
  channel = new BroadcastChannel<TabMessage>('ex-tabs', options);
  elector = createLeaderElection(channel);
  void elector.awaitLeadership().then(() => {
    leader = true;
  });
  channel.onmessage = (msg) => {
    if (msg.tabId === tabId) return;
    if (msg.kind === 'bye') {
      remote.delete(msg.tabId);
      return;
    }
    remote.set(msg.tabId, { ...msg.state, at: Date.now() });
  };
  // Activity re-broadcasts are throttled; visibility, focus, attention
  // (hard-away/wake) and thread-scope flips always send — they are the exact
  // bits the leader's away/suppression decisions hinge on.
  setActivityBroadcast((at) => {
    if (at - lastActivityBroadcastAt < activityBroadcastThrottleMs) {
      lastActivityBroadcastAt = at;
      return;
    }
    lastActivityBroadcastAt = at;
    postState();
  });
  setAttentionBroadcast(postState);
  setThreadScopeBroadcast(postState);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onVisibilityChange);
  window.addEventListener('blur', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
  postState();
}

// onPageHide announces this tab's departure so siblings drop its state
// immediately instead of waiting out the staleness TTL.
function onPageHide(): void {
  try {
    void channel?.postMessage({ kind: 'bye', tabId }).catch(() => {});
  } catch {
    // Torn/closing channel — siblings fall back to the staleness TTL.
  }
}

// getTabChannelForTests / getTabElectorForTests expose the internals so
// tests can force the torn-channel failure arms (rejections) that a healthy
// simulate channel can never produce.
export function getTabChannelForTests(): unknown {
  return channel;
}

export function getTabElectorForTests(): unknown {
  return elector;
}

// isLeaderTab: true when elected — or when there is no coordinator at all
// (init never ran: tests, non-browser surfaces), which behaves single-tab.
export function isLeaderTab(): boolean {
  return leader || channel === null;
}

// hasOtherTabs reports whether any OTHER tab broadcast fresh state. While an
// election is still settling in a single-tab session, this is what lets the
// only tab dispatch immediately instead of waiting out the hold.
export function hasOtherTabs(): boolean {
  const cutoff = Date.now() - remoteStateTTL;
  for (const [id, s] of remote) {
    if (s.at >= cutoff) return true;
    remote.delete(id);
  }
  return false;
}

// setTabActiveParent records which conversation/channel this tab is viewing
// and shares it, so the leader can suppress popups for a parent the user is
// actively reading in ANY tab.
export function setTabActiveParent(parentID: string | null): void {
  localActiveParent = parentID;
  postState();
}

// The remote checks mirror the local two-tier split (SPEC §2, revised
// 2026-08-12):
//
// remoteTabAtDevice — the ACK tier's evidence: the sibling's snapshot is
// fresh, it is not hard-away (locked/suspended/woke), and it saw REAL input
// within the window. Visibility/focus are deliberately not consulted — input
// recency is the proof a human was at the device, and requiring the ex
// window to also be focused pushed every alert to the phone of a user
// working in another app. GAP-7's actual hole (a blurred tab vouching with
// NO input evidence) stays closed by R1: only real input stamps
// lastActivityAt, and a blurred tab receives no input.
function remoteTabAtDevice(s: TabState & { at: number }, withinMs: number): boolean {
  return (
    s.at >= Date.now() - remoteStateTTL &&
    // Strict === false: the snapshot must AFFIRM it is not hard-away. An
    // old-version sibling that omits the field can't prove its input stamps
    // survived a lock/wake, so it fails toward "away" — the safe direction.
    s.hardAway === false &&
    s.lastActivityAt >= Date.now() - withinMs
  );
}

// remoteTabAttentive — the SUPPRESSION tier: "surface nothing" claims the
// user is LOOKING at that tab, so it additionally requires the page visible
// and the window FOCUSED (SPEC R5/GAP-7): a visible-but-blurred tab on a
// second monitor must never justify suppressing an alert entirely.
function remoteTabAttentive(s: TabState & { at: number }, withinMs: number): boolean {
  return remoteTabAtDevice(s, withinMs) && s.visible && s.focused === true;
}

// remoteTabViewing: some OTHER tab is attentive and viewing this parent —
// the whole-device version of the active-view suppression.
export function remoteTabViewing(parentID: string, withinMs: number): boolean {
  for (const s of remote.values()) {
    if (remoteTabAttentive(s, withinMs) && s.activeParent === parentID) {
      return true;
    }
  }
  return false;
}

// remoteTabViewingThread: some OTHER tab is attentive and reading this thread
// root (open panel or /threads card in view) — the whole-device version of
// the thread suppression (SPEC I-5).
export function remoteTabViewingThread(threadRootID: string, withinMs: number): boolean {
  for (const s of remote.values()) {
    if (remoteTabAttentive(s, withinMs) && (s.activeThreads ?? []).includes(threadRootID)) {
      return true;
    }
  }
  return false;
}

// remoteUserAtDevice: some OTHER tab saw real input within the window and is
// not hard-away — the whole-device version of the ack gate's "user
// demonstrably at the device". Focus/visibility of that tab is irrelevant
// here (see remoteTabAtDevice).
export function remoteUserAtDevice(withinMs: number): boolean {
  for (const s of remote.values()) {
    if (remoteTabAtDevice(s, withinMs)) {
      return true;
    }
  }
  return false;
}

// resetTabCoordinatorForTests tears the module singleton down so each test
// starts from the uncoordinated (single-tab) baseline.
export async function resetTabCoordinatorForTests(): Promise<void> {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('focus', onVisibilityChange);
  window.removeEventListener('blur', onVisibilityChange);
  window.removeEventListener('pagehide', onPageHide);
  setActivityBroadcast(null);
  setAttentionBroadcast(null);
  setThreadScopeBroadcast(null);
  // try/catch (not .catch): bc returns undefined — not a promise — from a
  // second close/die on an already-torn channel, and can also throw
  // synchronously; both shapes land here.
  if (elector) {
    try {
      await elector.die();
    } catch {
      // torn — nothing left to announce
    }
    elector = null;
  }
  if (channel) {
    try {
      await channel.close();
    } catch {
      // torn — already gone
    }
    channel = null;
  }
  leader = false;
  localActiveParent = null;
  lastActivityBroadcastAt = 0;
  remote.clear();
}
