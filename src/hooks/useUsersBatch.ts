import { useMemo } from 'react';
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { User } from '@/types';

// usersBatchMax is the most ids /users/batch accepts per request.
const usersBatchMax = 100;

// User records (display name, avatar URL) change rarely; see staleTime below.
const usersStaleMs = 5 * 60_000;

// freshUsers collects the users other batches already hold and that are still
// fresh — not invalidated (a user.updated invalidates every batch) and inside
// the stale time.
function freshUsers(qc: QueryClient): Map<string, User> {
  const known = new Map<string, User>();
  for (const q of qc.getQueryCache().findAll({ queryKey: queryKeys.usersBatch() })) {
    // A query with no data counts as stale, so past this point it has some.
    if (q.isStaleByTime(usersStaleMs)) continue;
    for (const u of q.state.data as User[]) known.set(u.id, u);
  }
  return known;
}

// Resolves a set of user IDs to user records via /users/batch — one request
// per 100 ids, in parallel. Several views (Sidebar DM avatars, ChannelView
// member map, ConversationView participant map, Activity) share it so the
// cache key, dedup, and stale time stay consistent.
//
// Only ids no fresh batch already holds are fetched: a set that grows by one
// person (a new reaction in the Activity list, a new DM) costs one id, not a
// refetch of everyone.
export function useUsersBatch(ids: string[]) {
  const qc = useQueryClient();
  const sortedIDs = useMemo(() => [...new Set(ids)].sort(), [ids]);
  const query = useQuery({
    queryKey: queryKeys.usersBatch(sortedIDs),
    queryFn: async () => {
      const known = freshUsers(qc);
      const missing = sortedIDs.filter((id) => !known.has(id));
      const chunks: string[][] = [];
      for (let i = 0; i < missing.length; i += usersBatchMax) chunks.push(missing.slice(i, i + usersBatchMax));
      const pages = await Promise.all(
        chunks.map((ids) =>
          apiFetch<User[]>('/api/v1/users/batch', { method: 'POST', body: JSON.stringify({ ids }) }),
        ),
      );
      const reused = sortedIDs.flatMap((id) => {
        const u = known.get(id);
        return u ? [u] : [];
      });
      return [...reused, ...pages.flatMap((res) => (Array.isArray(res) ? res : []))];
    },
    enabled: sortedIDs.length > 0,
    // User records (display name, avatar URL) change rarely. Cache for
    // 5 minutes and skip the window-focus refetch — every alt-tab back
    // would otherwise re-issue this and cause every Avatar on screen to
    // briefly flash a fallback while the new <img> loads.
    staleTime: usersStaleMs,
    refetchOnWindowFocus: false,
    // A grown id set is a new query; keep showing the names already known
    // while it loads instead of flashing every row to its fallback.
    placeholderData: keepPreviousData,
  });
  const map = useMemo(() => {
    const m = new Map<string, User>();
    for (const u of query.data ?? []) m.set(u.id, u);
    return m;
  }, [query.data]);
  return { ...query, map };
}
