import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { setDocumentNotificationCount } from '@/lib/document-title';
import { getSeenMap, mergeSeenMaps, THREAD_SEEN_CHANGED_EVENT, unreadThreadIDs, useUserThreads } from '@/hooks/useThreads';
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
    const seenMap = mergeSeenMaps(userState?.threadSeen, localSeenMap);
    return unreadThreadIDs(threads, userState?.threadNotifications ?? [], unreadThreadNotifications, seenMap).size;
  }, [isAuthenticated, localSeenMap, threads, unreadThreadNotifications, userState]);

  // Sum the ALERTED-unread counts straight from the channel / conversation
  // list cache (the single source the sidebar badges also read) — the tab
  // title mirrors the numeric badges, so it climbs only for messages that
  // actually notified this user per their rules. Merely-unread chatter shows
  // as the sidebar availability dot and never inflates the title. No mute
  // filter needed: mute suppresses the alert server-side (a mention
  // overrides it, deliberately — those DO count).
  const messageTotal = useMemo(() => {
    let total = 0;
    for (const c of channels) {
      total += Number(c.unreadNotifyCount ?? 0);
    }
    for (const c of conversations) {
      total += Number(c.unreadNotifyCount ?? 0);
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
