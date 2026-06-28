import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { setDocumentNotificationCount } from '@/lib/document-title';
import { getSeenMap, THREAD_SEEN_CHANGED_EVENT, unreadThreadIDs, useUserThreads } from '@/hooks/useThreads';
import { useUserState } from '@/hooks/useUserState';

function sumCounts(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}

export function NotificationCountTitleBridge() {
  const { isAuthenticated } = useAuth();
  const { channelUnreadCounts, conversationUnreadCounts, unreadThreadNotifications } = useUnread();
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

  // Sum the actual unread MESSAGE counts (channels + conversations), so the tab
  // title climbs as more messages arrive in a parent — the old code counted
  // distinct unread parents (Set sizes), so multiple messages in one channel
  // were stuck at "(1)". The count maps are the same single source the sidebar
  // badges read (seeded from the server seq count by UnreadServerCountSync).
  const count = isAuthenticated
    ? sumCounts(channelUnreadCounts) + sumCounts(conversationUnreadCounts) + unreadThreads
    : 0;

  useEffect(() => {
    setDocumentNotificationCount(count);
  }, [count]);

  useEffect(() => () => setDocumentNotificationCount(0), []);

  return null;
}
