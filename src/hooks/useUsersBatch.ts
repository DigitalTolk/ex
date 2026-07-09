import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { User } from '@/types';

// Resolves a set of user IDs to user records via /users/batch in a single
// request. Three views (Sidebar DM avatars, ChannelView member map,
// ConversationView participant map) used to inline this — keeping it in
// one place means the cache key, dedup, and stale time stay consistent.
export function useUsersBatch(ids: string[]) {
  const sortedIDs = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const query = useQuery({
    queryKey: queryKeys.usersBatch(sortedIDs),
    queryFn: async () => {
      const res = await apiFetch<User[]>('/api/v1/users/batch', {
        method: 'POST',
        body: JSON.stringify({ ids: sortedIDs }),
      });
      return Array.isArray(res) ? res : [];
    },
    enabled: sortedIDs.length > 0,
    // User records (display name, avatar URL) change rarely. Cache for
    // 5 minutes and skip the window-focus refetch — every alt-tab back
    // would otherwise re-issue this and cause every Avatar on screen to
    // briefly flash a fallback while the new <img> loads.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const map = useMemo(() => {
    const m = new Map<string, User>();
    for (const u of query.data ?? []) m.set(u.id, u);
    return m;
  }, [query.data]);
  return { ...query, map };
}
