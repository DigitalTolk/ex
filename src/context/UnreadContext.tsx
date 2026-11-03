import { createContext, useContext, useMemo, useState, useCallback, useRef, type ReactNode } from 'react';
import { readJSON, writeJSON } from '@/lib/storage';
import { apiFetch } from '@/lib/api';
import { isThreadInView, setPanelThread } from '@/lib/thread-scope';
import { isActiveParent } from '@/stores/active-parent';

// No unread counts live here. Channel/DM unread comes straight from the
// userChannels / userConversations list cache (server seq-derived), patched
// live via @/lib/unread-cache; unread threads are the server's markers in the
// user state (useUnreadThreadIDs).
interface UnreadState {
  hiddenConversations: Set<string>;
  hideConversation: (id: string) => void;
  unhideConversation: (id: string) => void;
  // Active scope: marking unread is suppressed when the user is currently
  // looking at the channel or conversation (read it as you go instead). The
  // open parent itself lives in stores/active-parent (useParentChat sets it).
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
  const [hiddenConversations, setHiddenConversations] = useState<Set<string>>(loadHiddenConversations);
  // A ref (not state) so updates from onMessageNew callbacks see the latest
  // active thread without re-creating the WS handlers on every navigation.
  const activeThreadRef = useRef<string | null>(null);

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

  const isActiveChannel = useCallback((id: string) => isActiveParent('channel', id), []);
  const isActiveConversation = useCallback((id: string) => isActiveParent('conversation', id), []);
  const setActiveThread = useCallback((id: string | null) => {
    activeThreadRef.current = id;
    // Share the open panel's thread with @/lib/thread-scope so notification
    // suppression (this tab + siblings via tab-leader) knows it's being read.
    setPanelThread(id);
  }, []);
  // Active = the open ThreadPanel OR a /threads card currently in the
  // viewport (thread-scope) — reading a thread inline on /threads must
  // suppress the Threads-nav badge exactly like the panel does (SPEC GAP-5).
  const isActiveThread = useCallback(
    (id: string) => activeThreadRef.current === id || isThreadInView(id),
    [],
  );

  // The callbacks are all stable (useCallback), so memoizing here means the
  // context value's identity only changes when the hidden state actually
  // changes — not on every unrelated re-render — sparing all sidebar/nav
  // consumers a re-render per parent tick.
  const value = useMemo(
    () => ({
      hiddenConversations,
      hideConversation,
      unhideConversation,
      isActiveChannel,
      isActiveConversation,
      setActiveThread,
      isActiveThread,
    }),
    [
      hiddenConversations,
      hideConversation,
      unhideConversation,
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
