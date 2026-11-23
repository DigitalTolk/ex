import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

// How much of the ranking the @-list uses: plenty to order a roster by.
const FREQUENT_PEOPLE_LIMIT = 50;

const NO_RANKING: ReadonlyMap<string, number> = new Map();

// useFrequentPeople is the caller's people ranking (who they mention and
// message most, kept by the server from their sends) as person ID → rank,
// 0 the most frequent. The composer's @-list puts them first. A failed read
// leaves the list in its usual order.
export function useFrequentPeople(enabled: boolean): ReadonlyMap<string, number> {
  const { data } = useQuery({
    queryKey: queryKeys.frequentPeople(),
    queryFn: async () => {
      const res = await apiFetch<string[]>(`/api/v1/users/me/frequent-people?limit=${FREQUENT_PEOPLE_LIMIT}`);
      return Array.isArray(res) ? res.filter((id): id is string => typeof id === 'string') : [];
    },
    staleTime: 5 * 60 * 1000,
    enabled,
  });
  return useMemo(() => (data ? new Map(data.map((id, i) => [id, i])) : NO_RANKING), [data]);
}
