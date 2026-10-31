import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
import type { UserState } from '@/types';

// useUnreadThreadIDs is the set of unread threads — what the bold Threads
// cards and the message list's reply bars show — read passively from the user
// state the app keeps loaded, without fetching. They are the server's unread
// markers alone: it writes a reply's marker before notifying, and the
// notification reloads the user state. Nothing is added on the side: a thread
// read elsewhere in the meantime (on the phone) kept the Threads entry lit
// until a restart that way.
export function useUnreadThreadIDs(): Set<string> {
  const userState = useCachedQuery<UserState>(queryKeys.userState());
  return useMemo(() => new Set(userState?.threadNotifications), [userState]);
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
