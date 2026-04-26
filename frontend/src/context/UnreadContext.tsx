import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';

interface UnreadState {
  unreadChannels: Set<string>;
  unreadConversations: Set<string>;
  hiddenConversations: Set<string>;
  markChannelUnread: (channelId: string) => void;
  markConversationUnread: (conversationId: string) => void;
  clearChannelUnread: (channelId: string) => void;
  clearConversationUnread: (conversationId: string) => void;
  hideConversation: (id: string) => void;
  unhideConversation: (id: string) => void;
  // Active scope: marking unread is suppressed when the user is currently
  // looking at the channel or conversation.
  setActiveChannel: (id: string | null) => void;
  setActiveConversation: (id: string | null) => void;
  isActiveChannel: (id: string) => boolean;
  isActiveConversation: (id: string) => boolean;
}

const UnreadContext = createContext<UnreadState | undefined>(undefined);

function loadHiddenConversations(): Set<string> {
  try {
    const stored = localStorage.getItem('hidden_conversations');
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

function persistHiddenConversations(set: Set<string>) {
  localStorage.setItem('hidden_conversations', JSON.stringify([...set]));
}

export function UnreadProvider({ children }: { children: ReactNode }) {
  const [unreadChannels, setUnreadChannels] = useState<Set<string>>(new Set());
  const [unreadConversations, setUnreadConversations] = useState<Set<string>>(new Set());
  const [hiddenConversations, setHiddenConversations] = useState<Set<string>>(loadHiddenConversations);
  // Refs (not state) so updates from onMessageNew callbacks see the latest
  // active scope without re-creating the WS handlers on every navigation.
  const activeChannelRef = useRef<string | null>(null);
  const activeConvRef = useRef<string | null>(null);

  const markChannelUnread = useCallback((id: string) => {
    if (activeChannelRef.current === id) return;
    setUnreadChannels(prev => new Set(prev).add(id));
  }, []);
  const markConversationUnread = useCallback((id: string) => {
    if (activeConvRef.current === id) return;
    setUnreadConversations(prev => new Set(prev).add(id));
  }, []);
  const clearChannelUnread = useCallback((id: string) => {
    setUnreadChannels(prev => { const next = new Set(prev); next.delete(id); return next; });
  }, []);
  const clearConversationUnread = useCallback((id: string) => {
    setUnreadConversations(prev => { const next = new Set(prev); next.delete(id); return next; });
  }, []);

  const hideConversation = useCallback((id: string) => {
    setHiddenConversations(prev => {
      const next = new Set(prev).add(id);
      persistHiddenConversations(next);
      return next;
    });
  }, []);

  const unhideConversation = useCallback((id: string) => {
    setHiddenConversations(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      persistHiddenConversations(next);
      return next;
    });
  }, []);

  const setActiveChannel = useCallback((id: string | null) => {
    activeChannelRef.current = id;
    if (id) {
      setUnreadChannels(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, []);
  const setActiveConversation = useCallback((id: string | null) => {
    activeConvRef.current = id;
    if (id) {
      setUnreadConversations(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, []);
  const isActiveChannel = useCallback((id: string) => activeChannelRef.current === id, []);
  const isActiveConversation = useCallback((id: string) => activeConvRef.current === id, []);

  return (
    <UnreadContext.Provider value={{
      unreadChannels,
      unreadConversations,
      hiddenConversations,
      markChannelUnread,
      markConversationUnread,
      clearChannelUnread,
      clearConversationUnread,
      hideConversation,
      unhideConversation,
      setActiveChannel,
      setActiveConversation,
      isActiveChannel,
      isActiveConversation,
    }}>
      {children}
    </UnreadContext.Provider>
  );
}

export function useUnread() {
  const ctx = useContext(UnreadContext);
  if (!ctx) throw new Error('useUnread must be used within UnreadProvider');
  return ctx;
}
