import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

// SearchIndexStat mirrors search.IndexStat in the backend; kept thin so
// the admin panel can render rows without coupling to internal types.
export interface SearchIndexStat {
  name: string;
  health: string;
  status: string;
  docs: number;
  storeSize: string;
}

export interface SearchReindexProgress {
  running: boolean;
  users: number;
  channels: number;
  messages: number;
  files: number;
  lastError?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface SearchAdminStatus {
  configured: boolean;
  cluster?: Record<string, unknown>;
  clusterError?: string;
  indices?: SearchIndexStat[];
  indicesError?: string;
  reindex?: SearchReindexProgress;
}

// useSearchAdminStatus polls the admin search-status endpoint. While a
// reindex is running we tighten the interval so progress numbers tick
// visibly; otherwise a 30s heartbeat is plenty.
export function useSearchAdminStatus() {
  return useQuery({
    queryKey: ['admin-search-status'],
    queryFn: () => apiFetch<SearchAdminStatus>('/api/v1/admin/search/status'),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.reindex?.running) return 2_000;
      return 30_000;
    },
    staleTime: 1_000,
  });
}

// useStartSearchReindex fires off a background reindex run. The status
// query is invalidated on success so the panel flips to "running"
// immediately rather than waiting for the next poll.
export function useStartSearchReindex() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<SearchReindexProgress>('/api/v1/admin/search/reindex', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-search-status'] });
    },
  });
}
