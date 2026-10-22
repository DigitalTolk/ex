import { useQuery, keepPreviousData, type UseQueryResult } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

export interface SearchHit {
  id: string;
  score: number;
  _source: Record<string, unknown>;
}

export interface AggBucket {
  key: string;
  count: number;
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
  // Optional terms-aggregation buckets keyed by name (e.g. "byUser",
  // "byParent"); populated by the messages and files endpoints so
  // result-driven filter dropdowns can show only relevant options.
  aggs?: Record<string, AggBucket[]>;
}

export interface MessageQueryOpts {
  from?: string;
  in?: string;
  sort?: '' | 'newest' | 'oldest';
}

const MIN_QUERY_CHARS = 2;

function buildURL(index: string, q: string, limit: number, opts?: MessageQueryOpts): string {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (opts?.from) params.set('from', opts.from);
  if (opts?.in) params.set('in', opts.in);
  if (opts?.sort) params.set('sort', opts.sort);
  return `/api/v1/search/${index}?${params.toString()}`;
}

function useSearchQuery(
  index: 'users' | 'channels' | 'messages' | 'files',
  q: string,
  limit: number,
  enabled: boolean,
  opts?: MessageQueryOpts,
  // nonce participates in the query key so callers can force a
  // re-fetch (e.g. clicking the same hashtag twice).
  nonce?: number,
): UseQueryResult<SearchResult> {
  const trimmed = q.trim();
  // Empty `q` is allowed when the caller has set a `from` or `in`
  // filter — "all messages by user X" needs no text. The backend
  // enforces RBAC and short-circuits if both are missing.
  const filterOnly = !!(opts?.from || opts?.in);
  return useQuery({
    queryKey: queryKeys.search(index, trimmed, limit, opts ?? {}, nonce ?? 0),
    // The signal cancels a search the next keystroke overtook, so a slow
    // backend isn't left working through every one of them.
    queryFn: async ({ signal }) => withSources(await apiFetch<SearchResult>(buildURL(index, trimmed, limit, opts), { signal })),
    enabled: enabled && (trimmed.length >= MIN_QUERY_CHARS || filterOnly),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // A search that timed out says so at once; sending it again doubled the
    // wait. The reader can try again.
    retry: false,
  });
}

// Every hit has a _source to read, even one the index returned without.
function withSources(res: SearchResult | undefined): SearchResult | null {
  if (!res) return null;
  return { ...res, hits: (res.hits ?? []).map((hit) => (hit._source ? hit : { ...hit, _source: {} })) };
}

export function useSearchUsers(q: string, enabled: boolean, limit = 5) {
  return useSearchQuery('users', q, limit, enabled);
}

export function useSearchChannels(q: string, enabled: boolean, limit = 5) {
  return useSearchQuery('channels', q, limit, enabled);
}

export function useSearchMessages(
  q: string,
  enabled: boolean,
  limit = 8,
  opts?: MessageQueryOpts,
  nonce?: number,
) {
  return useSearchQuery('messages', q, limit, enabled, opts, nonce);
}

/* istanbul ignore next -- the sole caller (SearchResultsPage) always passes an explicit limit, so the `= 8` default-parameter arm is never applied. */
export function useSearchFiles(q: string, enabled: boolean, limit = 8, opts?: MessageQueryOpts) {
  return useSearchQuery('files', q, limit, enabled, opts);
}
