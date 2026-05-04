import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { setDocumentNotificationCount } from '@/lib/document-title';
import { getSeenMap, hasUnreadActivity, THREAD_SEEN_CHANGED_EVENT, useUserThreads } from '@/hooks/useThreads';
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
    const threadIDs = new Set([...(userState?.threadNotifications ?? []), ...unreadThreadNotifications]);
    const seenMap = { ...(userState?.threadSeen ?? {}), ...localSeenMap };
    for (const thread of threads) {
      if (seenMap[thread.threadRootID] && hasUnreadActivity(thread, seenMap)) {
        threadIDs.add(thread.threadRootID);
      }
    }
    return threadIDs.size;
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
