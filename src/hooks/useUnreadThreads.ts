import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import { useOptionalUnread } from '@/context/UnreadContext';
import { unreadThreadIDs } from '@/hooks/useThreads';
import type { UserState } from '@/types';

// useUnreadThreadIDs is the set of unread threads — what the Threads dot,
// the bold Threads cards and the message list's reply bars show — read
// passively from the user state the app keeps loaded, without fetching.
export function useUnreadThreadIDs(): Set<string> {
  const userState = useCachedQuery<UserState>(queryKeys.userState());
  const live = useOptionalUnread()?.unreadThreadNotifications;
  return useMemo(() => unreadThreadIDs(userState?.threadNotifications, live), [userState, live]);
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
