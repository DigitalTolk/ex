import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useOptionalUnread } from '@/context/UnreadContext';
import {
  getSeenMap,
  mergeSeenMaps,
  THREAD_SEEN_CHANGED_EVENT,
  unreadThreadIDs,
  type ThreadSummary,
} from '@/hooks/useThreads';
import type { UserState } from '@/types';

// useUnreadThreadIDs is the set of unread threads — the same one the Threads
// count uses — read passively from the query cache the sidebar keeps loaded,
// so a component like the message list can mark reply bars without fetching.
export function useUnreadThreadIDs(): Set<string> {
  const threads = useCachedQuery<ThreadSummary[]>(queryKeys.userThreads());
  const userState = useCachedQuery<UserState>(queryKeys.userState());
  const live = useOptionalUnread()?.unreadThreadNotifications;
  const [localSeen, setLocalSeen] = useState(getSeenMap);
  useEffect(() => {
    const onSeen = () => setLocalSeen(getSeenMap());
    window.addEventListener(THREAD_SEEN_CHANGED_EVENT, onSeen);
    return () => window.removeEventListener(THREAD_SEEN_CHANGED_EVENT, onSeen);
  }, []);
  return useMemo(
    () =>
      unreadThreadIDs(
        threads ?? [],
        userState?.threadNotifications ?? [],
        live ?? new Set(),
        mergeSeenMaps(userState?.threadSeen, localSeen, userState?.threadMarkedUnread),
      ),
    [threads, userState, live, localSeen],
  );
}

// useCachedQuery reads a query's cached data and re-renders when it changes,
// without registering an observer (which would fetch, or overwrite the
// owning query's options with a queryFn-less copy).
function useCachedQuery<T>(key: readonly unknown[]): T | undefined {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [queryClient],
  );
  return useSyncExternalStore(subscribe, () => queryClient.getQueryData<T>(key));
}
