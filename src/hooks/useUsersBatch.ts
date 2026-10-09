import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { User } from '@/types';

// usersBatchMax is the most ids /users/batch accepts per request.
const usersBatchMax = 100;

// Resolves a set of user IDs to user records via /users/batch — one request
// per 100 ids, in parallel. Several views (Sidebar DM avatars, ChannelView
// member map, ConversationView participant map, Activity) share it so the
// cache key, dedup, and stale time stay consistent.
export function useUsersBatch(ids: string[]) {
  const sortedIDs = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const query = useQuery({
    queryKey: queryKeys.usersBatch(sortedIDs),
    queryFn: async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < sortedIDs.length; i += usersBatchMax) chunks.push(sortedIDs.slice(i, i + usersBatchMax));
      const pages = await Promise.all(
        chunks.map((ids) =>
          apiFetch<User[]>('/api/v1/users/batch', { method: 'POST', body: JSON.stringify({ ids }) }),
        ),
      );
      return pages.flatMap((res) => (Array.isArray(res) ? res : []));
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
