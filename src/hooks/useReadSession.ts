import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { cachedUnreadCount } from '@/lib/unread-cache';
import {
  clearMissedArrivals,
  clearUnreadAnchor,
  isAtBottom,
  isReadHeld,
  keepReadSession,
  releaseRead,
  scheduleEndReadSession,
  setAtBottom,
  setUnreadAnchor,
} from '@/lib/read-position';
import { useMarkReadOnReturn } from '@/hooks/useMarkReadOnReturn';

export interface ReadSession {
  // The message list reports when the user reaches / leaves the live tail.
  onAtBottomChange: (atBottom: boolean) => void;
  // The banner's "Mark as read": clears the line and any unread hold.
  markAllRead: () => void;
  // Before leaving a link-opened window for the newest messages: forget the
  // missed arrivals and put the line where the unread messages start.
  prepareJumpToLatest: () => void;
}

// useReadSession runs an open chat's read lifecycle, Slack/Mattermost style:
//   - Opening it reads it (the badge clears), but first records where the
//     unread messages start, so the "New messages" line keeps your place
//     until you leave.
//   - After that it auto-reads only while you're following along at the
//     live tail: coming back to the window, or scrolling back down to the
//     bottom, reads what arrived meanwhile.
//   - "Mark as unread" holds it unread: nothing auto-reads it until you
//     leave or mark it read yourself.
export function useReadSession(
  parentType: 'channel' | 'conversation',
  parentID: string | undefined,
  markRead: (id: string) => void,
): ReadSession {
  const queryClient = useQueryClient();
  const listReady = useListSettled(parentType);
  const openedRef = useRef<string | null>(null);

  // Open: once per chat, as soon as its unread count is known.
  useEffect(() => {
    if (!parentID || !listReady || openedRef.current === parentID) return;
    openedRef.current = parentID;
    const pending = cachedUnreadCount(queryClient, parentType, parentID) ?? 0;
    if (pending > 0) setUnreadAnchor(parentID, { kind: 'count', count: pending });
    if (!isReadHeld(parentID)) markRead(parentID);
  }, [parentID, parentType, listReady, markRead, queryClient]);

  // Leave: the line and any hold belong to this visit only. (openedRef is
  // deliberately not reset: it's what keeps StrictMode's remount from
  // "opening" — and so reading — the chat a second time.)
  useEffect(() => {
    if (!parentID) return;
    keepReadSession(parentID);
    return () => scheduleEndReadSession(parentID);
  }, [parentID]);

  // Back to the window: read what arrived while away — unless scrolled up
  // or held unread.
  useMarkReadOnReturn(parentID, (id) => {
    if (!isReadHeld(id) && isAtBottom(id)) markRead(id);
  });

  const onAtBottomChange = useCallback(
    (atBottom: boolean) => {
      if (!parentID) return;
      setAtBottom(parentID, atBottom);
      if (!atBottom || isReadHeld(parentID)) return;
      if ((cachedUnreadCount(queryClient, parentType, parentID) ?? 0) > 0) markRead(parentID);
    },
    [parentID, parentType, markRead, queryClient],
  );

  const markAllRead = useCallback(() => {
    if (!parentID) return;
    releaseRead(parentID);
    clearUnreadAnchor(parentID);
    markRead(parentID);
  }, [parentID, markRead]);

  const prepareJumpToLatest = useCallback(() => {
    if (!parentID) return;
    clearMissedArrivals(parentID);
    const pending = cachedUnreadCount(queryClient, parentType, parentID) ?? 0;
    if (pending > 0) setUnreadAnchor(parentID, { kind: 'count', count: pending }, { replace: true });
  }, [parentID, parentType, queryClient]);

  return { onAtBottomChange, markAllRead, prepareJumpToLatest };
}

// useListSettled: the sidebar list holding this chat's unread count has
// finished loading (or failed, or was never requested — nothing to wait for).
// Cache events fire while other components render, so the change callback is
// batched the way React Query's own hooks do it.
function useListSettled(parentType: 'channel' | 'conversation'): boolean {
  const queryClient = useQueryClient();
  const key = parentType === 'channel' ? queryKeys.userChannels() : queryKeys.userConversations();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [queryClient],
  );
  const status = useSyncExternalStore(subscribe, () => queryClient.getQueryState(key)?.status);
  return status !== 'pending';
}
