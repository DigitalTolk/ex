import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { User } from '@/types';

// Resolves a set of user IDs to user records via /users/batch in a single
// request. Three views (Sidebar DM avatars, ChannelView member map,
// ConversationView participant map) used to inline this — keeping it in
// one place means the cache key, dedup, and stale time stay consistent.
export function useUsersBatch(ids: string[]) {
  const sortedIDs = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const query = useQuery({
    queryKey: ['users-batch', sortedIDs],
    queryFn: () =>
      apiFetch<User[]>('/api/v1/users/batch', {
        method: 'POST',
        body: JSON.stringify({ ids: sortedIDs }),
      }),
    enabled: sortedIDs.length > 0,
    staleTime: 60_000,
  });
  const map = useMemo(() => {
    const m = new Map<string, User>();
    for (const u of query.data ?? []) m.set(u.id, u);
    return m;
  }, [query.data]);
  return { ...query, map };
}
