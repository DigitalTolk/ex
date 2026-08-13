import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { playNotificationPing } from '@/lib/notification-sound';
import { hasDndBridge, isDndActive } from '@/lib/dnd';
import { showToast } from '@/lib/toast';
import { readJSON, writeJSON } from '@/lib/storage';
import { useLatestRef } from '@/hooks/useLatestRef';
import { sendWS } from '@/lib/ws-sender';
import { hasSeenNotification, recordNotification } from '@/lib/notification-dedup';
import {
  attentionWindowMs,
  isUserAtDevice,
  isUserAttentive,
  startUserActivityTracking,
  suppressionWindowMs,
} from '@/lib/user-activity';
import { isThreadInView } from '@/lib/thread-scope';
import { traceNotification } from '@/lib/notification-trace';
import { startIdleDetection, stopIdleDetection } from '@/lib/idle-detector';
import {
  isLeaderTab,
  hasOtherTabs,
  setTabActiveParent,
  remoteTabViewing,
  remoteTabViewingThread,
  remoteUserAtDevice,
  nonLeaderHoldMs,
} from '@/lib/tab-leader';

// The attention windows live in @/lib/user-activity (SPEC §8):
//   - attentionWindowMs (10min): how recently a VISIBLE+FOCUSED page must
//     have seen real input for the desktop to claim the alert (ack → the
//     deferred mobile push stands down). Beyond it the laptop may be open but
//     the user is gone — withhold the ack and let the mobile fallback fire,
//     Slack-style. Duplicates (desktop popup + phone buzz) are the deliberate
//     failure direction; a lost alert is not.
//   - suppressionWindowMs (2min): the stricter tier for surfacing NOTHING
//     because the user is looking right at the parent (SPEC R5) — the
//     highest-risk action, so it demands the freshest proof. When in doubt,
//     surface a popup instead.

// Max age of a buffered ack at flush time (SPEC I-13): an ack that sat in the
// reconnect buffer through a sleep/wake must not cancel a mobile push long
// after the fact. Must stay < the backend's ackFallbackDelay (30s) — pinned
// by attention-constants.test.ts.
export const ackFreshnessMs = 15_000;

// deviceAttentive: was a human demonstrably at this DEVICE recently — real
// input within the attention window in THIS tab or a sibling, and no
// definitive not-at-device signal (lock / suspend / wake latch)? The gate
// for every ack (SPEC R4, revised 2026-08-12).
//
// Deliberately NOT window-focus/page-visibility gated: the OS banner
// surfaces over whatever app the user is in, so "which window has focus"
// says nothing about whether the human saw it. Requiring focus here was the
// regression that buzzed the phone for every alert while the user sat at
// the desktop working in another window. Focus/visibility still gate the
// SUPPRESSION tier below (surfacing nothing is a claim about looking at
// the ex window itself).
function deviceAttentive(): boolean {
  return isUserAtDevice(attentionWindowMs) || remoteUserAtDevice(attentionWindowMs);
}

// ackDesktopDelivery tells the backend the desktop made the user aware of this
// message (we surfaced it, or they were already looking at the channel), so the
// deferred mobile-push fallback stands down. A dead/absent socket can't send
// this — so no ack → the backend pushes to mobile. This is what closes the
// "desktop looked online but never delivered" hole.
function ackDesktopDelivery(messageID: string | undefined): void {
  if (!messageID) return;
  // buffer: true so an ack sent during a reconnect blip is flushed on
  // reconnect rather than dropped — the deferred mobile push must still be
  // cancelled even if the socket flickered right after the popup surfaced.
  // maxAgeMs bounds that: an ack stale enough that the push already fired
  // (or should fire) is dropped at flush, never sent (SPEC I-13).
  sendWS({ type: 'notification.ack', messageID }, { buffer: true, maxAgeMs: ackFreshnessMs });
}

// NotificationKind mirrors backend service.NotificationKind. Adding a new
// kind here is the single client-side place where a new alert flavor is
// recognized — keep this in lockstep with the Go side.
export type NotificationKind = 'message' | 'mention' | 'thread_reply';

export interface NotificationPayload {
  kind: NotificationKind;
  title: string;
  body: string;
  deepLink: string;
  parentID: string;
  parentType: 'channel' | 'conversation';
  messageID?: string;
  parentMessageID?: string;
  authorID?: string;
  // True for incoming-webhook posts (CI/deploy/alert bots). The authorID
  // is the webhook's creator, not a real sender, so these are exempt from
  // the own-author echo suppression below. Whether to notify at all is the
  // backend's level-gated decision, same as any other message.
  webhook?: boolean;
  createdAt: string;
  // Authoritative alerted-unread badge for the parent AFTER this alert
  // (top-level messages only). Clients SET the sidebar row to this value —
  // never increment locally — so duplicate/replayed events can't drift it.
  parentUnreadNotifyCount?: number;
}

type Permission = NotificationPermission | 'unsupported';

interface NotificationPrefs {
  // Independent of OS permission so a user can keep notifications
  // enabled at the OS level but silenced in-app.
  soundEnabled: boolean;
  browserEnabled: boolean;
  // Chromium IdleDetector opt-in (SPEC R6 layer 2): OS idle + screen lock
  // detection in the plain browser. Off by default — it needs an explicit
  // permission grant from a user gesture.
  idleDetectionEnabled: boolean;
}

interface NotificationContextValue {
  prefs: NotificationPrefs;
  setSoundEnabled: (v: boolean) => void;
  setBrowserEnabled: (v: boolean) => void;
  setIdleDetectionEnabled: (v: boolean) => void;
  permission: Permission;
  requestPermission: () => Promise<Permission>;
  dispatch: (n: NotificationPayload) => void;
  setActiveParent: (parentID: string | null) => void;
  setCurrentUserID: (id: string | null) => void;
}

const STORAGE_KEY = 'ex.notifications.prefs.v1';
const DEFAULT_PREFS: NotificationPrefs = {
  soundEnabled: true,
  browserEnabled: true,
  idleDetectionEnabled: false,
};

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function loadPrefs(): NotificationPrefs {
  const parsed = readJSON<Partial<NotificationPrefs>>(STORAGE_KEY, {});
  return {
    soundEnabled: parsed.soundEnabled ?? DEFAULT_PREFS.soundEnabled,
    browserEnabled: parsed.browserEnabled ?? DEFAULT_PREFS.browserEnabled,
    idleDetectionEnabled: parsed.idleDetectionEnabled ?? DEFAULT_PREFS.idleDetectionEnabled,
  };
}

function readPermission(): Permission {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

// SPA navigation so a notification click doesn't trigger a full page
// reload. Setting window.location.href reloads the document and wipes
// the user's loaded message history, which on a deep-link landing
// leaves them with only the around-window plus one page on each side.
// pushState + popstate hands control to React Router without reload;
// fallback to href for cross-origin links (which the backend never
// produces today, but keeps the boundary safe).
function navigateInApp(href: string) {
  /* istanbul ignore next -- SSR guard: this browser-only app always has window */
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(href, window.location.origin);
    /* istanbul ignore next -- the backend only ever emits same-origin deep links; the cross-origin full-reload arm is a defensive boundary that would navigate the test page away if forced */
    if (url.origin !== window.location.origin) {
      window.location.href = href;
      return;
    }
    window.history.pushState(null, '', url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } catch {
    /* istanbul ignore next -- URL() with a valid base does not throw for the same-origin links the app produces; the catch is a defensive fallback */
    window.location.href = href;
  }
}

// playPingRespectingDnd plays the in-app custom ping, gated on the desktop
// shell's native Focus/DnD state when the bridge exists (async IPC — the
// ping lags the banner by a few ms, which is imperceptible). Without a
// bridge the ping plays immediately: this path is only reached for surfaces
// the OS does not deliver, where no DnD signal exists.
function playPingRespectingDnd(): void {
  if (hasDndBridge()) {
    void isDndActive().then((dnd) => {
      if (!dnd) playNotificationPing();
    });
    return;
  }
  playNotificationPing();
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs);
  const [permission, setPermission] = useState<Permission>(readPermission);
  const activeParentRef = useRef<string | null>(null);
  const currentUserIDRef = useRef<string | null>(null);
  // Per-message dedup lives in @/lib/notification-dedup — a localStorage-backed
  // store SHARED across all of this user's browser tabs, so the same message
  // never pops once per tab. (A per-tab in-memory set, the old design, only
  // deduped within a single tab — where duplicates barely occur.)
  // Mirror reactive state into refs so `dispatch` can be a stable callback
  // — recreating it on every prefs/permission change would invalidate the
  // memoized context value and re-render every consumer of useNotifications.
  // Mirror reactive state into refs so `dispatch` can be a stable
  // callback — recreating it on every prefs/permission change would
  // invalidate the memoized context value and re-render every consumer.
  const prefsRef = useLatestRef(prefs);
  // Self-reference for the non-leader hold-retry: a held notification is
  // re-dispatched through the LATEST dispatch closure after the hold. The
  // `force` flag marks that re-entry so it skips the leader gate.
  // Declared before dispatch (which reads it) and synced after via effect.
  const dispatchRef = useRef<((n: NotificationPayload, force?: boolean) => void) | null>(null);
  const permissionRef = useLatestRef(permission);
  const initialMountRef = useRef(true);
  // Attention tracking (input recency + window focus + hard-away + wake
  // detection) lives in @/lib/user-activity — idempotent, lives for the page.
  // Window focus is part of isUserAttentive: `visibilityState` alone isn't
  // enough, since a backgrounded-but-not-minimized window stays `visible`.
  useEffect(() => {
    startUserActivityTracking();
  }, []);

  useEffect(() => {
    if (initialMountRef.current) {
      // Skip the first run — loadPrefs() already returned what's in
      // localStorage; rewriting it on mount is pointless I/O.
      initialMountRef.current = false;
      return;
    }
    writeJSON(STORAGE_KEY, prefs);
  }, [prefs]);

  const setSoundEnabled = useCallback((v: boolean) => {
    setPrefs((p) => ({ ...p, soundEnabled: v }));
  }, []);

  const setBrowserEnabled = useCallback((v: boolean) => {
    setPrefs((p) => ({ ...p, browserEnabled: v }));
  }, []);

  const setIdleDetectionEnabled = useCallback((v: boolean) => {
    setPrefs((p) => ({ ...p, idleDetectionEnabled: v }));
  }, []);

  // Run the Chromium IdleDetector while the opt-in is on. startIdleDetection
  // is a safe no-op (returns false) when the API is missing or permission was
  // never granted; stopping releases any latched hard-away.
  useEffect(() => {
    if (!prefs.idleDetectionEnabled) return;
    void startIdleDetection();
    return () => stopIdleDetection();
  }, [prefs.idleDetectionEnabled]);

  const requestPermission = useCallback(async (): Promise<Permission> => {
    if (!notificationsSupported()) return 'unsupported';
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }, []);

  const setActiveParent = useCallback((id: string | null) => {
    activeParentRef.current = id;
    // Share the viewing state so the LEADER tab can suppress popups for a
    // parent the user is actively reading in this (possibly non-leader) tab.
    setTabActiveParent(id);
  }, []);

  const setCurrentUserID = useCallback((id: string | null) => {
    currentUserIDRef.current = id;
  }, []);

  const dispatch = useCallback((n: NotificationPayload, force = false) => {
    const now = Date.now();
    // Drop a repeat of a message we've ALREADY alerted on (multi-tab fan-out /
    // a double-publish). Only a *check* here — we record the messageID as
    // alerted at the very end, and only once we actually surface sound or a
    // popup. Recording up-front (the previous behaviour) meant a copy that was
    // merely suppressed (you were viewing the channel) or that failed to
    // surface (popup threw in a webview, or permission not yet granted)
    // permanently deduped the messageID, so a later legitimate delivery was
    // silently swallowed. For an incident channel that is exactly the alert you
    // cannot afford to lose. Notifications without a messageID (defensive) skip
    // dedup entirely. A duplicate still acks: it proves the desktop is alive and
    // already aware, so the mobile-push fallback should stand down.
    if (n.messageID && hasSeenNotification(n.messageID, now)) {
      // Ack ONLY when the user is demonstrably at the device (any tab). A
      // hidden second tab hitting this path used to ack UNCONDITIONALLY —
      // with two tabs open and the user away, the second tab's dedup-hit
      // always cancelled the deferred mobile push, deterministically
      // breaking the away → phone handoff. "Another session received the
      // fan-out" is not "a human saw it".
      const attentive = deviceAttentive();
      traceNotification('dedup', n.messageID, { acked: attentive });
      if (attentive) {
        ackDesktopDelivery(n.messageID);
      }
      return;
    }
    // Server-side recipient filtering already excludes the author, but
    // echoes via shared subscriptions can slip through. Webhook posts are
    // exempt: their authorID is the webhook's creator, who explicitly
    // wants the alert, so we never self-suppress them.
    if (!n.webhook && n.authorID && currentUserIDRef.current && n.authorID === currentUserIDRef.current) {
      traceNotification('own-author', n.messageID);
      return;
    }
    // LEADER GATE: with several tabs open, every socket receives this event
    // but only the elected leader surfaces/acks it (it decides with
    // whole-device knowledge). A non-leader holds the payload and re-checks:
    // promoted meanwhile (leader tab closed between fan-out and dispatch) →
    // surface here; still not leader after a SECOND hold with nobody having
    // recorded the alert → surface anyway (SPEC GAP-13: the leader had two
    // full holds to deliver, so it died mid-surfacing or its election never
    // settled — a possible duplicate popup beats a silent miss). `force`
    // marks a held re-entry so it skips this gate. A tab that knows of no
    // other tabs dispatches immediately, so single-tab sessions (and an
    // election still settling on a lone tab) never wait.
    if (!force && !isLeaderTab() && hasOtherTabs()) {
      traceNotification('held', n.messageID);
      const holdRetry = (attempt: number): void => {
        window.setTimeout(() => {
          if (n.messageID && hasSeenNotification(n.messageID, Date.now())) return;
          if (isLeaderTab() || attempt >= 2) {
            if (!isLeaderTab()) traceNotification('hold-fallback', n.messageID);
            dispatchRef.current?.(n, true);
            return;
          }
          holdRetry(attempt + 1);
        }, nonLeaderHoldMs);
      };
      holdRetry(1);
      return;
    }
    // The backend is the single source of truth for *whether* a message
    // should notify: it folds the recipient's account level, per-channel
    // override (e.g. "all messages"), mute, keywords, @-mentions and thread
    // participation before it ever publishes a `notification.new`. So if one
    // arrives, the user opted into it — the client must NOT re-suppress by
    // kind/parentType (an earlier blanket "drop every channel message" rule
    // silently swallowed channel notifications even when the user set that
    // channel to "all messages"). The only client-side suppressions left are
    // orthogonal to level: own-author echo (above), per-message dedup (above),
    // and "I'm actively looking at this parent/thread" (below).
    //
    // ACTIVE-THREAD suppression (SPEC I-5): a reply into a thread the user is
    // READING right now — the open ThreadPanel or a /threads card in the
    // viewport, in THIS tab or a sibling — must not popup/ping over their
    // head. Matching is on the thread ROOT (parentMessageID), never on kind:
    // thread replies arrive as 'thread_reply' (or 'mention'), and gating on
    // *viewing* rather than kind keeps the backend the sole decider of
    // WHETHER to notify. isUserAttentive folds visible + focused + fresh
    // input + hard-away; the stricter suppression window applies (R5) — an
    // idle viewer gets a normal popup instead, and mobile gets its chance.
    if (
      n.parentMessageID &&
      ((isThreadInView(n.parentMessageID) && isUserAttentive(suppressionWindowMs)) ||
        remoteTabViewingThread(n.parentMessageID, suppressionWindowMs))
    ) {
      // Reading the thread right now — they're aware, so ack to stand the
      // mobile fallback down (no redundant push).
      traceNotification('suppressed-thread', n.messageID, { thread: n.parentMessageID });
      ackDesktopDelivery(n.messageID);
      return;
    }
    // ACTIVE-PARENT suppression: a regular channel/DM message is suppressed
    // only when the user is actually looking at that parent — attentive
    // (page visible, window focused, recent input, no hard-away signal; the
    // strict suppression window, R5) with that parent on screen, in this tab
    // or a sibling. A backgrounded/blurred window (even if still "visible"),
    // an idle viewer, or any other active conversation still gets the alert.
    if (
      n.kind === 'message' &&
      ((activeParentRef.current === n.parentID && isUserAttentive(suppressionWindowMs)) ||
        // Whole-device view: the user may be actively reading this parent in
        // ANOTHER tab — surfacing a popup from this (leader) tab over their
        // head was the multi-tab "popup for the channel I'm looking at" bug.
        remoteTabViewing(n.parentID, suppressionWindowMs))
    ) {
      // Suppressed because the user is looking right at it on desktop — they're
      // aware, so ack to stand the mobile fallback down (no redundant push).
      traceNotification('suppressed-parent', n.messageID, { parent: n.parentID });
      ackDesktopDelivery(n.messageID);
      return;
    }
    const { soundEnabled, browserEnabled } = prefsRef.current;
    // `delivered` tracks whether we actually surfaced an alert (sound and/or
    // popup). We only record the messageID as alerted when delivered — so a
    // copy that surfaced nothing (browser notifications off / not yet
    // permitted, and sound off; or the popup constructor threw) leaves the
    // door open for a retry/redelivery to still alert.
    let delivered = false;
    if (browserEnabled && permissionRef.current === 'granted' && notificationsSupported()) {
      try {
        // No `tag`: Chrome treats tag-collisions as silent thread updates
        // (no banner) regardless of `renotify`, so a second message in the
        // same channel would never alert. macOS/Windows already group by
        // origin at the OS level so per-message banners don't spam.
        const notificationOptions: NotificationOptions = {
          body: n.body,
          // The app owns the notification sound everywhere: the custom ping
          // plays below, so the OS banner is ALWAYS silent — banner + ping
          // must never double-sound. Inside the desktop shell the ping is
          // gated on the native Focus/DnD bridge; in a plain browser there
          // is no way to query Focus, and the deliberate trade-off
          // (2026-07-10) is to keep the custom ping there even though it
          // bypasses DnD. Only the shell gets DnD-correct pings.
          silent: true,
        };
        if (!window.__EX_DESKTOP__) {
          notificationOptions.icon = '/logo.svg';
        }
        const note = new Notification(n.title, notificationOptions);
        note.onclick = () => {
          window.focus();
          if (n.deepLink) navigateInApp(n.deepLink);
          note.close();
        };
        // Drop handler refs once the OS dismisses the notification so the
        // click closure (which retains `n` and `note`) becomes eligible
        // for GC immediately, instead of lingering as long as the entry
        // sits in the macOS Notification Center / Windows Action Center.
        note.onclose = () => {
          note.onclick = null;
          note.onclose = null;
        };
        delivered = true;
        if (soundEnabled) {
          // Custom ping alongside the (silent) banner. In the shell it is
          // suppressed when the bridge reports Focus/DnD — Slack/Mattermost
          // parity; under DnD the OS hides the banner too, and the alert
          // still counts as delivered: the user chose quiet, and their phone
          // (usually sharing the same Focus) should not buzz as a
          // "fallback". In a plain browser the ping just plays.
          playPingRespectingDnd();
        }
      } catch {
        // Some embedded webviews throw on the Notification constructor even
        // after the permission check passes. Fall back to the in-page ping
        // so the alert still surfaces audibly; if sound is off too,
        // `delivered` stays false so a retry isn't deduped away.
        if (soundEnabled) {
          playPingRespectingDnd();
          delivered = true;
        }
      }
    } else {
      if (soundEnabled) {
        playPingRespectingDnd();
        delivered = true;
      }
      if (browserEnabled && !notificationsSupported()) {
        // Webview fallback (Capacitor/WKWebView has no Notification API): an
        // in-app toast IS the popup surface. Without it, a foregrounded native
        // user with sound off got no in-app alert at all — the deferred OS push
        // (the no-ack fallback) arrived seconds late for an app they were
        // actively looking at. Surfacing the toast is a real delivery, so it
        // acks below and stands the mobile push down; tapping it deep-links to
        // the message like a popup click would.
        showToast(n.body || n.title, 'success', {
          title: n.body ? n.title : undefined,
          kind: 'notification',
          onActivate: () => {
            if (n.deepLink) navigateInApp(n.deepLink);
          },
        });
        delivered = true;
      }
    }
    // Record as alerted (shared across tabs) only after we actually surfaced
    // something, so a duplicate delivery doesn't double-ping/double-banner,
    // while a delivery that surfaced nothing stays eligible for a later retry.
    // Ack desktop delivery so the backend cancels the deferred mobile push.
    // The ack stays tied to actually surfacing (or active-view suppression
    // above): if the desktop surfaced NOTHING, we must NOT ack — the mobile
    // fallback is then the only way the alert reaches the user.
    if (n.messageID && delivered) {
      recordNotification(n.messageID, now);
      // Ack ONLY when someone was demonstrably at this device recently (real
      // input within the attention window in ANY tab, no lock/suspend/wake
      // latch — the ex window itself may be blurred or hidden; the OS banner
      // surfaces over whatever the user is doing). A popup surfaced on an
      // abandoned-but-open (or locked, or just-woken) laptop must not stand
      // the mobile push down — no ack means the backend's deferred fallback
      // delivers to the phone, Slack-style.
      const attentive = deviceAttentive();
      traceNotification('surfaced', n.messageID, { acked: attentive });
      if (attentive) {
        ackDesktopDelivery(n.messageID);
      }
    } else {
      traceNotification('no-surface', n.messageID, { delivered });
    }
  }, [permissionRef, prefsRef, dispatchRef]);

  useEffect(() => {
    dispatchRef.current = dispatch;
  });

  const value = useMemo(
    () => ({
      prefs,
      setSoundEnabled,
      setBrowserEnabled,
      setIdleDetectionEnabled,
      permission,
      requestPermission,
      dispatch,
      setActiveParent,
      setCurrentUserID,
    }),
    [prefs, permission, requestPermission, dispatch, setActiveParent, setCurrentUserID, setSoundEnabled, setBrowserEnabled, setIdleDetectionEnabled],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

// Returned when useNotifications is called outside a provider so unrelated
// tests don't have to wrap in NotificationProvider just to render.
const noopValue: NotificationContextValue = {
  prefs: { soundEnabled: false, browserEnabled: false, idleDetectionEnabled: false },
  setSoundEnabled: () => {},
  setBrowserEnabled: () => {},
  setIdleDetectionEnabled: () => {},
  permission: 'unsupported',
  requestPermission: async () => 'unsupported',
  dispatch: () => {},
  setActiveParent: () => {},
  setCurrentUserID: () => {},
};

export function useNotifications(): NotificationContextValue {
  return useContext(NotificationContext) ?? noopValue;
}
