import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

export interface UnfurlPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

// useUnfurl fetches the link preview for a single URL. Server returns
// 204 (caught here as a null preview) when the page can't be fetched
// or doesn't carry usable metadata; the caller renders nothing for
// those.
export function useUnfurl(url: string | null) {
  return useQuery<UnfurlPreview | null>({
    queryKey: queryKeys.unfurl(url ?? ''),
    queryFn: async () => {
      if (!url) return null;
      try {
        // apiFetch translates 204 → undefined; normalize to null.
        const preview = await apiFetch<UnfurlPreview | undefined>(
          `/api/v1/unfurl?url=${encodeURIComponent(url)}`,
        );
        return preview ?? null;
      } catch {
        // Any failure — non-2xx, network drop, malformed JSON — is
        // treated as "no preview". Caller renders nothing rather than
        // an error state.
        return null;
      }
    },
    enabled: !!url,
    // Match the server cache (7 days). Previews rarely change, and the
    // server already de-dupes the upstream fetch via Redis.
    staleTime: 7 * 24 * 60 * 60 * 1000,
    retry: false,
  });
}
