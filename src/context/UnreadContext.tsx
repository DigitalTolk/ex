import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react';
import { readJSON, writeJSON } from '@/lib/storage';
import { apiFetch } from '@/lib/api';
import { THREAD_SEEN_CHANGED_EVENT } from '@/hooks/useThreads';
import { isThreadInView, setPanelThread } from '@/lib/thread-scope';

interface UnreadState {
  // Thread-unread is the only unread state that still lives in the client: thread
  // replies don't bump the parent's seq, so there's no server-computed count to
  // read — this Set tracks live thread-reply notifications until the thread is
  // seen. Channel/DM unread counts come straight from the userChannels /
  // userConversations list cache (server seq-derived), patched live via
  // @/lib/unread-cache — NOT from this context.
  unreadThreadNotifications: Set<string>;
  hiddenConversations: Set<string>;
  markThreadNotificationUnread: (threadRootId: string) => void;
  hideConversation: (id: string) => void;
  unhideConversation: (id: string) => void;
  // Active scope: marking unread is suppressed when the user is currently
  // looking at the channel or conversation (read it as you go instead).
  setActiveChannel: (id: string | null) => void;
  setActiveConversation: (id: string | null) => void;
  isActiveChannel: (id: string) => boolean;
  isActiveConversation: (id: string) => boolean;
  // Active thread: the thread root currently shown in the open ThreadPanel,
  // whether opened via the URL (?thread=) or locally ("Reply in thread").
  // A new reply to the active thread must not light up the Threads nav.
  setActiveThread: (threadRootId: string | null) => void;
  isActiveThread: (threadRootId: string) => boolean;
}

const UnreadContext = createContext<UnreadState | undefined>(undefined);

const HIDDEN_KEY = 'hidden_conversations';
export const USER_STATE_CHANGED_EVENT = 'ex:user-state-changed';

function notifyUserStateChanged() {
  /* istanbul ignore else -- SSR guard: this browser-only app always has window */
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(USER_STATE_CHANGED_EVENT));
  }
}

function loadHiddenConversations(): Set<string> {
  return new Set(readJSON<string[]>(HIDDEN_KEY, []));
}

function persistHiddenConversations(set: Set<string>) {
  writeJSON(HIDDEN_KEY, [...set]);
}

export function UnreadProvider({ children }: { children: ReactNode }) {
  const [unreadThreadNotifications, setUnreadThreadNotifications] = useState<Set<string>>(new Set());
  const [hiddenConversations, setHiddenConversations] = useState<Set<string>>(loadHiddenConversations);
  // Refs (not state) so updates from onMessageNew callbacks see the latest
  // active scope without re-creating the WS handlers on every navigation.
  const activeChannelRef = useRef<string | null>(null);
  const activeConvRef = useRef<string | null>(null);
  const activeThreadRef = useRef<string | null>(null);

  const markThreadNotificationUnread = useCallback((id: string) => {
    setUnreadThreadNotifications(prev => new Set(prev).add(id));
    notifyUserStateChanged();
  }, []);

  const hideConversation = useCallback((id: string) => {
    setHiddenConversations(prev => {
      const next = new Set(prev).add(id);
      persistHiddenConversations(next);
      void apiFetch<void>(`/api/v1/user-state/conversations/${encodeURIComponent(id)}/hidden`, { method: 'PUT' })
        .catch(() => undefined)
        .finally(notifyUserStateChanged);
      return next;
    });
  }, []);

  const unhideConversation = useCallback((id: string) => {
    setHiddenConversations(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      persistHiddenConversations(next);
      void apiFetch<void>(`/api/v1/user-state/conversations/${encodeURIComponent(id)}/hidden`, { method: 'DELETE' })
        .catch(() => undefined)
        .finally(notifyUserStateChanged);
      return next;
    });
  }, []);

  const setActiveChannel = useCallback((id: string | null) => {
    activeChannelRef.current = id;
  }, []);
  const setActiveConversation = useCallback((id: string | null) => {
    activeConvRef.current = id;
  }, []);
  const isActiveChannel = useCallback((id: string) => activeChannelRef.current === id, []);
  const isActiveConversation = useCallback((id: string) => activeConvRef.current === id, []);
  const setActiveThread = useCallback((id: string | null) => {
    activeThreadRef.current = id;
    // Share the open panel's thread with @/lib/thread-scope so notification
    // suppression (this tab + siblings via tab-leader) knows it's being read.
    setPanelThread(id);
    // Opening a thread clears any pending live notification for it, so the
    // Threads nav doesn't stay highlighted from a reply that arrived just
    // before it was opened.
    if (id) {
      setUnreadThreadNotifications(prev => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);
  // Active = the open ThreadPanel OR a /threads card currently in the
  // viewport (thread-scope) — reading a thread inline on /threads must
  // suppress the Threads-nav badge exactly like the panel does (SPEC GAP-5).
  const isActiveThread = useCallback(
    (id: string) => activeThreadRef.current === id || isThreadInView(id),
    [],
  );

  useEffect(() => {
    const handleThreadSeen = (event: Event) => {
      const threadRootID = (event as CustomEvent<{ threadRootID?: string }>).detail?.threadRootID;
      if (!threadRootID) return;
      setUnreadThreadNotifications(prev => {
        if (!prev.has(threadRootID)) return prev;
        const next = new Set(prev);
        next.delete(threadRootID);
        return next;
      });
    };
    window.addEventListener(THREAD_SEEN_CHANGED_EVENT, handleThreadSeen);
    return () => window.removeEventListener(THREAD_SEEN_CHANGED_EVENT, handleThreadSeen);
  }, []);

  // The callbacks are all stable (useCallback), so memoizing here means the
  // context value's identity only changes when unread/hidden state actually
  // changes — not on every unrelated re-render — sparing all sidebar/nav
  // consumers a re-render per parent tick.
  const value = useMemo(
    () => ({
      unreadThreadNotifications,
      hiddenConversations,
      markThreadNotificationUnread,
      hideConversation,
      unhideConversation,
      setActiveChannel,
      setActiveConversation,
      isActiveChannel,
      isActiveConversation,
      setActiveThread,
      isActiveThread,
    }),
    [
      unreadThreadNotifications,
      hiddenConversations,
      markThreadNotificationUnread,
      hideConversation,
      unhideConversation,
      setActiveChannel,
      setActiveConversation,
      isActiveChannel,
      isActiveConversation,
      setActiveThread,
      isActiveThread,
    ],
  );

  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}

export function useUnread() {
  const ctx = useContext(UnreadContext);
  if (!ctx) throw new Error('useUnread must be used within UnreadProvider');
  return ctx;
}
