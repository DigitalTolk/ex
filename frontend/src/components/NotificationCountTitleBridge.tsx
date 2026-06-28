import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { setDocumentNotificationCount } from '@/lib/document-title';
import { getSeenMap, THREAD_SEEN_CHANGED_EVENT, unreadThreadIDs, useUserThreads } from '@/hooks/useThreads';
import { useUserState } from '@/hooks/useUserState';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';

export function NotificationCountTitleBridge() {
  const { isAuthenticated } = useAuth();
  const { unreadThreadNotifications } = useUnread();
  const { data: threads = [] } = useUserThreads({ enabled: isAuthenticated });
  const { data: userState } = useUserState({ enabled: isAuthenticated });
  const { data: channels = [] } = useUserChannels({ enabled: isAuthenticated });
  const { data: conversations = [] } = useUserConversations({ enabled: isAuthenticated });
  const [localSeenMap, setLocalSeenMap] = useState(() => getSeenMap());

  useEffect(() => {
    const handleSeenChange = () => setLocalSeenMap(getSeenMap());
    window.addEventListener(THREAD_SEEN_CHANGED_EVENT, handleSeenChange);
    return () => window.removeEventListener(THREAD_SEEN_CHANGED_EVENT, handleSeenChange);
  }, []);

  const unreadThreads = useMemo(() => {
    if (!isAuthenticated) {
      return 0;
    }
    const seenMap = { ...(userState?.threadSeen ?? {}), ...localSeenMap };
    return unreadThreadIDs(threads, userState?.threadNotifications ?? [], unreadThreadNotifications, seenMap).size;
  }, [isAuthenticated, localSeenMap, threads, unreadThreadNotifications, userState]);

  // Sum the server-computed unread MESSAGE counts straight from the channel /
  // conversation list cache (the single source the sidebar badges also read), so
  // the tab title climbs as more messages arrive in a parent. MUTED channels are
  // excluded (muted = quiet): the sidebar shows them as a dot with no count, so
  // their chatter must not inflate the tab title either. Conversations can't be
  // muted, so all of their counts contribute.
  const messageTotal = useMemo(() => {
    let total = 0;
    for (const c of channels) {
      if (c.muted) continue;
      total += c.unreadCount ?? 0;
    }
    for (const c of conversations) {
      total += c.unreadCount ?? 0;
    }
    return total;
  }, [channels, conversations]);

  const count = isAuthenticated ? messageTotal + unreadThreads : 0;

  useEffect(() => {
    setDocumentNotificationCount(count);
  }, [count]);

  useEffect(() => () => setDocumentNotificationCount(0), []);

  return null;
}
