import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { playNotificationPing } from '@/lib/notification-sound';
import { readJSON, writeJSON } from '@/lib/storage';
import { useLatestRef } from '@/hooks/useLatestRef';

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
  authorID?: string;
  createdAt: string;
}

type Permission = NotificationPermission | 'unsupported';

interface NotificationPrefs {
  // Independent of OS permission so a user can keep notifications
  // enabled at the OS level but silenced in-app.
  soundEnabled: boolean;
  browserEnabled: boolean;
}

interface NotificationContextValue {
  prefs: NotificationPrefs;
  setSoundEnabled: (v: boolean) => void;
  setBrowserEnabled: (v: boolean) => void;
  permission: Permission;
  requestPermission: () => Promise<Permission>;
  dispatch: (n: NotificationPayload) => void;
  setActiveParent: (parentID: string | null) => void;
  setCurrentUserID: (id: string | null) => void;
}

const STORAGE_KEY = 'ex.notifications.prefs.v1';
const DEFAULT_PREFS: NotificationPrefs = { soundEnabled: true, browserEnabled: true };

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function loadPrefs(): NotificationPrefs {
  const parsed = readJSON<Partial<NotificationPrefs>>(STORAGE_KEY, {});
  return {
    soundEnabled: parsed.soundEnabled ?? DEFAULT_PREFS.soundEnabled,
    browserEnabled: parsed.browserEnabled ?? DEFAULT_PREFS.browserEnabled,
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
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) {
      window.location.href = href;
      return;
    }
    window.history.pushState(null, '', url.pathname + url.search + url.hash);
    window.dispatchEvent(new PopStateEvent('popstate'));
  } catch {
    window.location.href = href;
  }
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs);
  const [permission, setPermission] = useState<Permission>(readPermission);
  const activeParentRef = useRef<string | null>(null);
  const currentUserIDRef = useRef<string | null>(null);
  // Mirror reactive state into refs so `dispatch` can be a stable callback
  // — recreating it on every prefs/permission change would invalidate the
  // memoized context value and re-render every consumer of useNotifications.
  // Mirror reactive state into refs so `dispatch` can be a stable
  // callback — recreating it on every prefs/permission change would
  // invalidate the memoized context value and re-render every consumer.
  const prefsRef = useLatestRef(prefs);
  const permissionRef = useLatestRef(permission);
  const initialMountRef = useRef(true);

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

  const requestPermission = useCallback(async (): Promise<Permission> => {
    if (!notificationsSupported()) return 'unsupported';
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }, []);

  const setActiveParent = useCallback((id: string | null) => {
    activeParentRef.current = id;
  }, []);

  const setCurrentUserID = useCallback((id: string | null) => {
    currentUserIDRef.current = id;
  }, []);

  const dispatch = useCallback((n: NotificationPayload) => {
    // Server-side recipient filtering already excludes the author, but
    // echoes via shared subscriptions can slip through.
    if (n.authorID && currentUserIDRef.current && n.authorID === currentUserIDRef.current) {
      return;
    }
    // Channels are noisy by default — only escalate when the message is
    // *for you*. Backend filters thread_reply notifications to actual
    // thread participants, so receiving one implies you replied in it.
    if (n.parentType === 'channel' && n.kind === 'message') {
      return;
    }
    // Mentions and thread replies still escalate when the parent is on
    // screen — a mention can scroll out of view, a thread reply lives in
    // a side panel that may not be open.
    if (
      n.kind === 'message' &&
      activeParentRef.current &&
      activeParentRef.current === n.parentID
    ) {
      return;
    }
    const { soundEnabled, browserEnabled } = prefsRef.current;
    if (soundEnabled) {
      playNotificationPing();
    }
    if (!browserEnabled || permissionRef.current !== 'granted' || !notificationsSupported()) {
      return;
    }
    try {
      // No `tag`: Chrome treats tag-collisions as silent thread updates
      // (no banner) regardless of `renotify`, so a second message in the
      // same channel would never alert. macOS/Windows already group by
      // origin at the OS level so per-message banners don't spam.
      const note = new Notification(n.title, {
        body: n.body,
        icon: '/logo.svg',
        silent: soundEnabled,
      });
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
    } catch {
      // Some embedded webviews throw on the Notification constructor
      // even after the permission check passes.
    }
  }, [permissionRef, prefsRef]);

  const value = useMemo(
    () => ({
      prefs,
      setSoundEnabled,
      setBrowserEnabled,
      permission,
      requestPermission,
      dispatch,
      setActiveParent,
      setCurrentUserID,
    }),
    [prefs, permission, requestPermission, dispatch, setActiveParent, setCurrentUserID, setSoundEnabled, setBrowserEnabled],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

// Returned when useNotifications is called outside a provider so unrelated
// tests don't have to wrap in NotificationProvider just to render.
const noopValue: NotificationContextValue = {
  prefs: { soundEnabled: false, browserEnabled: false },
  setSoundEnabled: () => {},
  setBrowserEnabled: () => {},
  permission: 'unsupported',
  requestPermission: async () => 'unsupported',
  dispatch: () => {},
  setActiveParent: () => {},
  setCurrentUserID: () => {},
};

export function useNotifications(): NotificationContextValue {
  return useContext(NotificationContext) ?? noopValue;
}
