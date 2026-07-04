import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

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

// SearchMappingRebuildProgress mirrors search.MappingRebuildStatus. This is the
// cluster-coordinated users/channels mapping rebuild (staging + alias-swap) —
// distinct from `reindex` (which repopulates docs into the live indices).
export interface SearchMappingRebuildProgress {
  running: boolean;
  users: number;
  channels: number;
  lastError?: string;
  startedAt?: number;
  completedAt?: number;
}

// SearchSchemaVersion mirrors search.SchemaVersionInfo: the live schema
// generation of a versioned index vs the one this build expects. `current` is
// null when the index carries no stamp yet (freshly created / pre-versioning).
export interface SearchSchemaVersion {
  index: string;
  current: number | null;
  expected: number;
  stale: boolean;
}

export interface SearchAdminStatus {
  configured: boolean;
  cluster?: Record<string, unknown>;
  clusterError?: string;
  indices?: SearchIndexStat[];
  indicesError?: string;
  reindex?: SearchReindexProgress;
  mappingRebuild?: SearchMappingRebuildProgress;
  mappingRebuildError?: string;
  schemaVersions?: SearchSchemaVersion[];
  schemaVersionsError?: string;
}

// useSearchAdminStatus polls the admin search-status endpoint. While a
// reindex is running we tighten the interval so progress numbers tick
// visibly; otherwise a 30s heartbeat is plenty.
export function useSearchAdminStatus() {
  return useQuery({
    queryKey: queryKeys.adminSearchStatus(),
    queryFn: () => apiFetch<SearchAdminStatus>('/api/v1/admin/search/status'),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.reindex?.running || data?.mappingRebuild?.running) return 2_000;
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
      qc.invalidateQueries({ queryKey: queryKeys.adminSearchStatus() });
    },
  });
}

// useStartSearchMappingRebuild triggers the cluster-coordinated users/channels
// mapping rebuild (apply a new analyzer via staging + alias-swap). Like the
// reindex it's fire-and-poll; the status query is invalidated so the panel
// flips to "running" at once. A 409 (another instance already holds the lock)
// surfaces as a mutation error.
export function useStartSearchMappingRebuild() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<SearchMappingRebuildProgress>('/api/v1/admin/search/rebuild-mapping', {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.adminSearchStatus() });
    },
  });
}
