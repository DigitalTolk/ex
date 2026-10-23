import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient, type QueryFunctionContext } from '@tanstack/react-query';
import { APP_VERSION_META, BUILD_VERSION_META } from '@/lib/version-meta';
import { queryKeys } from '@/lib/query-keys';

// BUILD_VERSION reads `<meta name="app-version">` once on module load —
// it's whatever the server stamped into the same HTML that delivered
// this bundle, so the meta tag and the bundle always match. In dev (no
// meta tag), BUILD_VERSION is 'dev' and the banner stays suppressed.
function readBootVersion(): string {
  /* istanbul ignore next -- SSR guard: document is always defined in the browser test environment; reachable only under a Node render we don't do. */
  if (typeof document === 'undefined') return 'dev';
  const tag = document.querySelector(`meta[name="${APP_VERSION_META}"]`);
  /* istanbul ignore next -- runs once at module load; browser-setup.ts always stamps a non-empty app-version meta tag, so the || 'dev' fallback never fires and vi.resetModules cannot re-trigger module-load evaluation in browser mode. */
  return tag?.getAttribute('content') || 'dev';
}

export const BUILD_VERSION: string = readBootVersion();
export const BUILD_DISPLAY_VERSION: string = (() => {
  /* istanbul ignore next -- SSR guard: document is always defined in the browser test environment; reachable only under a Node render we don't do. */
  if (typeof document === 'undefined') return BUILD_VERSION;
  const tag = document.querySelector(`meta[name="${BUILD_VERSION_META}"]`);
  /* istanbul ignore next -- runs once at module load; browser-setup.ts always stamps a non-empty build-version meta tag, so the || BUILD_VERSION fallback never fires and vi.resetModules cannot re-trigger module-load evaluation in browser mode. */
  return tag?.getAttribute('content') || BUILD_VERSION;
})();

// The deployed server build as last reported — by the /api/v1/version poll,
// the server.version frame sent on every socket connect, or the version header
// on any API response — plus the ETag of the poll that reported it. Sending
// the ETag back as If-None-Match turns the steady-state poll into a 0-byte 304.
export interface ServerVersionState {
  version: string | null;
  etag: string | null;
}

// One minute: users see the banner shortly after a deploy, and the check is
// invisible at scale.
const POLL_INTERVAL_MS = 60_000;
// A failed check (network blip, app resumed while the server restarts) is
// retried soon instead of at the next minute tick: mobile webviews do not
// always report focus again once connectivity returns.
const RETRY_DELAY_MS = 5_000;

// lib/api reports the version header of every response through this window
// event. It has no query client to write to; each mounted version hook copies
// the report into its own.
const SERVER_VERSION_REPORTED = 'ex:server-version-reported';

async function fetchServerVersion({ client, queryKey, signal }: QueryFunctionContext): Promise<ServerVersionState> {
  const prev = client.getQueryData<ServerVersionState>(queryKey);
  const headers: Record<string, string> = {};
  if (prev?.etag) headers['If-None-Match'] = prev.etag;
  const res = await fetch('/api/v1/version', { headers, credentials: 'include', signal });
  // Not modified: what is cached is still current.
  if (res.status === 304) return prev ?? { version: null, etag: null };
  if (!res.ok) throw new Error(`version check failed (${res.status})`);
  const data = (await res.json()) as { version?: string } | null;
  return {
    version: data?.version || prev?.version || null,
    etag: res.headers.get('ETag') || prev?.etag || null,
  };
}

const serverVersionQuery = {
  queryKey: queryKeys.serverVersion(),
  queryFn: fetchServerVersion,
  // Kept current by the poller and the pushed reports, never by an observer
  // mounting.
  staleTime: Infinity,
} as const;

function selectVersion(state: ServerVersionState): string | null {
  return state.version;
}

// applyServerVersionEvent records a version the server pushed (the
// server.version WS frame, or a response header). The cached ETag stays: it
// belongs to the poll response it came with.
export function applyServerVersionEvent(client: QueryClient, version: string): void {
  if (!version) return;
  client.setQueryData<ServerVersionState>(queryKeys.serverVersion(), (prev) => ({
    version,
    etag: prev?.etag ?? null,
  }));
}

// reportServerVersion is lib/api's way in: it fires the window event every
// mounted version hook listens for.
export function reportServerVersion(version: string): void {
  window.dispatchEvent(new CustomEvent<string>(SERVER_VERSION_REPORTED, { detail: version }));
}

function useReportedServerVersions(): void {
  const client = useQueryClient();
  useEffect(() => {
    const onReport = (event: Event) => applyServerVersionEvent(client, (event as CustomEvent<string>).detail);
    window.addEventListener(SERVER_VERSION_REPORTED, onReport);
    return () => window.removeEventListener(SERVER_VERSION_REPORTED, onReport);
  }, [client]);
}

// useServerVersionPoller keeps the version current: mounted once, at the app
// root. A check every minute, on the page becoming visible again, on
// reconnecting, and on a back/forward-cache restore (the frozen page resumes,
// possibly across a deploy, and not every browser reports it visible again).
export function useServerVersionPoller(): void {
  const { refetch } = useQuery({
    ...serverVersionQuery,
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    retry: true,
    retryDelay: RETRY_DELAY_MS,
    // Nothing renders from it.
    notifyOnChangeProps: [],
  });
  useReportedServerVersions();
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) void refetch({ cancelRefetch: false });
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [refetch]);
}

export function useServerVersion(): {
  serverVersion: string | null;
  outdated: boolean;
} {
  const { data } = useQuery({
    ...serverVersionQuery,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    select: selectVersion,
  });
  useReportedServerVersions();
  const v = data ?? null;

  // Banner shows only after we've heard a server version AND it differs
  // from the bundle-baked one. Suppressed entirely in dev where the
  // bundle has no embedded version.
  /* istanbul ignore next -- BUILD_VERSION is a module-load constant read from the stamped app-version meta tag, which browser-setup.ts always sets to a real version (never 'dev'), so the && short-circuits and import.meta.env.DEV is never evaluated under the browser gate. */
  const devBuildWithoutServerStamp = BUILD_VERSION === 'dev' && import.meta.env.DEV;
  const outdated = v !== null && v !== BUILD_VERSION && !devBuildWithoutServerStamp;
  return { serverVersion: v, outdated };
}
