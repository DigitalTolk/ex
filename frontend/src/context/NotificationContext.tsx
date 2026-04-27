import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { playNotificationPing } from '@/lib/notification-sound';

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
  // User-facing toggles persisted to localStorage. Independent of OS
  // permission so a user can keep notifications enabled but silenced.
  soundEnabled: boolean;
  browserEnabled: boolean;
}

interface NotificationContextValue {
  prefs: NotificationPrefs;
  setSoundEnabled: (v: boolean) => void;
  setBrowserEnabled: (v: boolean) => void;
  permission: Permission;
  requestPermission: () => Promise<Permission>;
  // Called by the WebSocket handler when a notification.new event arrives.
  // The context decides whether to play sound / show OS popup based on the
  // current view (suppress alerts for the channel/conversation already on
  // screen) and the user prefs.
  dispatch: (n: NotificationPayload) => void;
  // Routes used by the page-on-screen suppression. ChatPage calls these.
  setActiveParent: (parentID: string | null) => void;
  // Current viewer's user id, used for own-author suppression so a user
  // doesn't get pinged by their own messages echoed back over the socket.
  setCurrentUserID: (id: string | null) => void;
}

const STORAGE_KEY = 'ex.notifications.prefs.v1';

function loadPrefs(): NotificationPrefs {
  if (typeof localStorage === 'undefined') {
    return { soundEnabled: true, browserEnabled: true };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { soundEnabled: true, browserEnabled: true };
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    return {
      soundEnabled: parsed.soundEnabled ?? true,
      browserEnabled: parsed.browserEnabled ?? true,
    };
  } catch {
    return { soundEnabled: true, browserEnabled: true };
  }
}

function savePrefs(p: NotificationPrefs) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

function readPermission(): Permission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(loadPrefs);
  const [permission, setPermission] = useState<Permission>(readPermission);
  const activeParentRef = useRef<string | null>(null);
  const currentUserIDRef = useRef<string | null>(null);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const setSoundEnabled = useCallback((v: boolean) => {
    setPrefs((p) => ({ ...p, soundEnabled: v }));
  }, []);

  const setBrowserEnabled = useCallback((v: boolean) => {
    setPrefs((p) => ({ ...p, browserEnabled: v }));
  }, []);

  const requestPermission = useCallback(async (): Promise<Permission> => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'unsupported';
    }
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

  const dispatch = useCallback(
    (n: NotificationPayload) => {
      // Never alert for messages the viewer authored — their own send shouldn't
      // ping them. Server-side recipient filtering already excludes the author,
      // but echoes via shared subscriptions can slip through.
      if (n.authorID && currentUserIDRef.current && n.authorID === currentUserIDRef.current) {
        return;
      }
      // Suppress only regular-message popups for the parent the user is
      // currently viewing — those land in the visible message list, no
      // popup adds value. Mentions and thread replies escalate and should
      // alert even when the parent is on screen: a mention in a long
      // channel might scroll out of view, and a thread reply lives in a
      // panel the user hasn't opened.
      if (
        n.kind === 'message' &&
        activeParentRef.current &&
        activeParentRef.current === n.parentID
      ) {
        return;
      }
      if (prefs.soundEnabled) {
        playNotificationPing();
      }
      // In-app toast — the primary popup. Always fires regardless of OS
      // permission so the user sees alerts even if they never granted
      // browser notifications, dismissed the prompt, or are on a browser
      // that suppresses Notification API while the tab is focused
      // (e.g. Safari ≥16). Click to deep-link to the message.
      toast(n.title, {
        description: n.body,
        duration: 6000,
        onAutoClose: () => undefined,
        action: n.deepLink
          ? {
              label: 'Open',
              onClick: () => {
                window.location.href = n.deepLink;
              },
            }
          : undefined,
      });
      // OS-level popup is the bonus path — only fires when the user has
      // explicitly granted permission AND the browser is willing to show
      // it. Failures here are silent because the toast already covered
      // the user-visible alert.
      if (
        prefs.browserEnabled &&
        typeof window !== 'undefined' &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        try {
          const note = new Notification(n.title, {
            body: n.body,
            tag: `${n.parentType}:${n.parentID}`,
            silent: prefs.soundEnabled, // OS sound off when we already played our own
          });
          note.onclick = () => {
            window.focus();
            if (n.deepLink) window.location.href = n.deepLink;
            note.close();
          };
        } catch {
          // Notification constructor can throw on some embedded browsers;
          // the toast above is still showing.
        }
      }
    },
    [prefs.soundEnabled, prefs.browserEnabled],
  );

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

// noopValue is returned when useNotifications is called outside a provider.
// This keeps test setups simple — a component that only *consumes* the
// dispatch (e.g. for active-parent tracking) shouldn't force every test
// to wrap in NotificationProvider just to render. Throwing here was the
// original posture but made unrelated layout tests fail noisily.
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
