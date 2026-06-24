import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react';
import { readJSON, writeJSON } from '@/lib/storage';
import { apiFetch } from '@/lib/api';
import { THREAD_SEEN_CHANGED_EVENT } from '@/hooks/useThreads';

interface UnreadState {
  unreadChannels: Set<string>;
  unreadChannelNotifications: Set<string>;
  unreadConversations: Set<string>;
  unreadThreadNotifications: Set<string>;
  hiddenConversations: Set<string>;
  // Live per-target unread message counts, accumulated from WebSocket
  // message.new events received while the channel/conversation isn't
  // active. Reset to 0 (entry removed) when the target is opened or its
  // unread is cleared. Session-only — a cold load knows unread as a
  // boolean (server-persisted) but not a count, so a target absent from
  // these maps is rendered with the unread dot rather than a number.
  channelUnreadCounts: Map<string, number>;
  conversationUnreadCounts: Map<string, number>;
  markChannelUnread: (channelId: string) => void;
  markChannelNotificationUnread: (channelId: string) => void;
  markConversationUnread: (conversationId: string) => void;
  markThreadNotificationUnread: (threadRootId: string) => void;
  clearChannelUnread: (channelId: string) => void;
  clearConversationUnread: (conversationId: string) => void;
  // Drop the live session delta (unreadChannels + per-channel counts) so the
  // server-computed unread (UserChannel.unread/unreadCount) becomes the sole
  // source again. Called after a reconnect/replay-exhausted refetch, where the
  // refreshed server counts already include everything the deltas tracked —
  // keeping them would double-count.
  resetChannelSessionUnread: () => void;
  hideConversation: (id: string) => void;
  unhideConversation: (id: string) => void;
  // Active scope: marking unread is suppressed when the user is currently
  // looking at the channel or conversation.
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
  const [unreadChannels, setUnreadChannels] = useState<Set<string>>(new Set());
  const [unreadChannelNotifications, setUnreadChannelNotifications] = useState<Set<string>>(new Set());
  const [unreadConversations, setUnreadConversations] = useState<Set<string>>(new Set());
  const [unreadThreadNotifications, setUnreadThreadNotifications] = useState<Set<string>>(new Set());
  const [hiddenConversations, setHiddenConversations] = useState<Set<string>>(loadHiddenConversations);
  const [channelUnreadCounts, setChannelUnreadCounts] = useState<Map<string, number>>(new Map());
  const [conversationUnreadCounts, setConversationUnreadCounts] = useState<Map<string, number>>(new Map());
  // Refs (not state) so updates from onMessageNew callbacks see the latest
  // active scope without re-creating the WS handlers on every navigation.
  const activeChannelRef = useRef<string | null>(null);
  const activeConvRef = useRef<string | null>(null);
  const activeThreadRef = useRef<string | null>(null);

  const markChannelUnread = useCallback((id: string) => {
    if (activeChannelRef.current === id) return;
    setUnreadChannels(prev => new Set(prev).add(id));
    setChannelUnreadCounts(prev => new Map(prev).set(id, (prev.get(id) ?? 0) + 1));
  }, []);
  const markChannelNotificationUnread = useCallback((id: string) => {
    if (activeChannelRef.current === id) return;
    setUnreadChannelNotifications(prev => new Set(prev).add(id));
    notifyUserStateChanged();
  }, []);
  const markConversationUnread = useCallback((id: string) => {
    if (activeConvRef.current === id) return;
    setUnreadConversations(prev => new Set(prev).add(id));
    setConversationUnreadCounts(prev => new Map(prev).set(id, (prev.get(id) ?? 0) + 1));
  }, []);
  const markThreadNotificationUnread = useCallback((id: string) => {
    setUnreadThreadNotifications(prev => new Set(prev).add(id));
    notifyUserStateChanged();
  }, []);
  const clearChannelUnread = useCallback((id: string) => {
    setUnreadChannels(prev => { const next = new Set(prev); next.delete(id); return next; });
    setUnreadChannelNotifications(prev => { const next = new Set(prev); next.delete(id); return next; });
    setChannelUnreadCounts(prev => { if (!prev.has(id)) return prev; const next = new Map(prev); next.delete(id); return next; });
    void apiFetch<void>(`/api/v1/user-state/channels/${encodeURIComponent(id)}/notification`, { method: 'DELETE' })
      .catch(() => undefined)
      .finally(notifyUserStateChanged);
  }, []);
  const clearConversationUnread = useCallback((id: string) => {
    setUnreadConversations(prev => { const next = new Set(prev); next.delete(id); return next; });
    setConversationUnreadCounts(prev => { if (!prev.has(id)) return prev; const next = new Map(prev); next.delete(id); return next; });
  }, []);
  const resetChannelSessionUnread = useCallback(() => {
    setUnreadChannels(prev => (prev.size ? new Set() : prev));
    setChannelUnreadCounts(prev => (prev.size ? new Map() : prev));
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
    if (id) {
      setUnreadChannels(prev => { const next = new Set(prev); next.delete(id); return next; });
      setUnreadChannelNotifications(prev => { const next = new Set(prev); next.delete(id); return next; });
      setChannelUnreadCounts(prev => { if (!prev.has(id)) return prev; const next = new Map(prev); next.delete(id); return next; });
      void apiFetch<void>(`/api/v1/user-state/channels/${encodeURIComponent(id)}/notification`, { method: 'DELETE' })
        .catch(() => undefined)
        .finally(notifyUserStateChanged);
    }
  }, []);
  const setActiveConversation = useCallback((id: string | null) => {
    activeConvRef.current = id;
    if (id) {
      setUnreadConversations(prev => { const next = new Set(prev); next.delete(id); return next; });
      setConversationUnreadCounts(prev => { if (!prev.has(id)) return prev; const next = new Map(prev); next.delete(id); return next; });
    }
  }, []);
  const isActiveChannel = useCallback((id: string) => activeChannelRef.current === id, []);
  const isActiveConversation = useCallback((id: string) => activeConvRef.current === id, []);
  const setActiveThread = useCallback((id: string | null) => {
    activeThreadRef.current = id;
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
  const isActiveThread = useCallback((id: string) => activeThreadRef.current === id, []);

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
      unreadChannels,
      unreadChannelNotifications,
      unreadConversations,
      unreadThreadNotifications,
      hiddenConversations,
      channelUnreadCounts,
      conversationUnreadCounts,
      markChannelUnread,
      markChannelNotificationUnread,
      markConversationUnread,
      markThreadNotificationUnread,
      clearChannelUnread,
      clearConversationUnread,
      resetChannelSessionUnread,
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
      unreadChannels,
      unreadChannelNotifications,
      unreadConversations,
      unreadThreadNotifications,
      hiddenConversations,
      channelUnreadCounts,
      conversationUnreadCounts,
      markChannelUnread,
      markChannelNotificationUnread,
      markConversationUnread,
      markThreadNotificationUnread,
      clearChannelUnread,
      clearConversationUnread,
      resetChannelSessionUnread,
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
