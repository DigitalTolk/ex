import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { setDocumentNotificationCount } from '@/lib/document-title';
import { getSeenMap, THREAD_SEEN_CHANGED_EVENT, unreadThreadIDs, useUserThreads } from '@/hooks/useThreads';
import { useUserState } from '@/hooks/useUserState';

export function NotificationCountTitleBridge() {
  const { isAuthenticated } = useAuth();
  const { unreadChannelNotifications, unreadConversations, unreadThreadNotifications } = useUnread();
  const { data: threads = [] } = useUserThreads({ enabled: isAuthenticated });
  const { data: userState } = useUserState({ enabled: isAuthenticated });
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

  const count = isAuthenticated
    ? new Set([...(userState?.channelNotifications ?? []), ...unreadChannelNotifications]).size + unreadConversations.size + unreadThreads
    : 0;

  useEffect(() => {
    setDocumentNotificationCount(count);
  }, [count]);

  useEffect(() => () => setDocumentNotificationCount(0), []);

  return null;
}
