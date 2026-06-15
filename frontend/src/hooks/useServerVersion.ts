import { useEffect, useSyncExternalStore } from 'react';
import { APP_VERSION_META, BUILD_VERSION_META } from '@/lib/version-meta';

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

let serverVersion: string | null = null;
const subscribers = new Set<() => void>();

export function setServerVersion(v: string): void {
  if (!v || v === serverVersion) return;
  serverVersion = v;
  for (const cb of subscribers) cb();
}

export function resetServerVersionForTests(): void {
  serverVersion = null;
  lastETag = null;
  pollerCleanup?.();
  pollerCleanup = null;
  pollerStarted = false;
  if (subscribers.size === 0) return;
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): string | null {
  return serverVersion;
}

// pollIntervalMs is the cadence at which we check /api/v1/version. One
// minute is small enough that users see the banner shortly after a
// deploy and large enough that the check is invisible at scale.
const POLL_INTERVAL_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 5_000;

// Cached ETag from the previous /api/v1/version response. Sending it
// back as If-None-Match makes the server resolve the steady-state poll
// to a 0-byte 304 instead of a JSON payload.
let lastETag: string | null = null;

let pollerStarted = false;
let pollerCleanup: (() => void) | null = null;
function startPoller(): void {
  if (pollerStarted) return;
  pollerStarted = true;
  /* istanbul ignore next -- SSR guard: window is always defined in the browser test environment; reachable only under a Node render we don't do. */
  if (typeof window === 'undefined') return;
  let retryTimeoutID: number | null = null;
  const clearRetry = () => {
    if (retryTimeoutID === null) return;
    window.clearTimeout(retryTimeoutID);
    retryTimeoutID = null;
  };
  const scheduleRetry = () => {
    if (retryTimeoutID !== null) return;
    retryTimeoutID = window.setTimeout(() => {
      retryTimeoutID = null;
      void tick();
    }, RETRY_AFTER_FAILURE_MS);
  };
  const tick = async () => {
    try {
      const headers: HeadersInit = {};
      if (lastETag) headers['If-None-Match'] = lastETag;
      const res = await fetch('/api/v1/version', { headers, credentials: 'include' });
      if (res.status === 304) return;
      if (!res.ok) {
        scheduleRetry();
        return;
      }
      clearRetry();
      const etag = res.headers.get('ETag');
      if (etag) lastETag = etag;
      const data = (await res.json()) as { version?: string };
      if (data?.version) setServerVersion(data.version);
    } catch {
      // Network blip or app resume while the server is still restarting.
      // Mobile webviews do not always fire focus again after connectivity
      // returns, so retry soon instead of waiting for the next minute tick.
      scheduleRetry();
    }
  };
  const tickWhenVisible = () => {
    if (document.visibilityState === 'hidden') return;
    void tick();
  };
  const tickOnPageShow = () => {
    void tick();
  };
  const tickOnOnline = () => {
    void tick();
  };
  window.addEventListener('focus', tickWhenVisible);
  window.addEventListener('online', tickOnOnline);
  window.addEventListener('pageshow', tickOnPageShow);
  document.addEventListener('visibilitychange', tickWhenVisible);
  void tick();
  const intervalID = window.setInterval(tick, POLL_INTERVAL_MS);
  pollerCleanup = () => {
    clearRetry();
    window.removeEventListener('focus', tickWhenVisible);
    window.removeEventListener('online', tickOnOnline);
    window.removeEventListener('pageshow', tickOnPageShow);
    document.removeEventListener('visibilitychange', tickWhenVisible);
    window.clearInterval(intervalID);
  };
}

export function useServerVersion(): {
  serverVersion: string | null;
  outdated: boolean;
} {
  const v = useSyncExternalStore(subscribe, getSnapshot, () => null);

  // Lazy-start the poller the first time any consumer mounts. No
  // dependency injection, no Provider — the version is global state by
  // nature.
  useEffect(() => {
    startPoller();
  }, []);

  // Banner shows only after we've heard a server version AND it differs
  // from the bundle-baked one. Suppressed entirely in dev where the
  // bundle has no embedded version.
  /* istanbul ignore next -- BUILD_VERSION is a module-load constant read from the stamped app-version meta tag, which browser-setup.ts always sets to a real version (never 'dev'), so the && short-circuits and import.meta.env.DEV is never evaluated under the browser gate. */
  const devBuildWithoutServerStamp = BUILD_VERSION === 'dev' && import.meta.env.DEV;
  const outdated = v !== null && v !== BUILD_VERSION && !devBuildWithoutServerStamp;
  return { serverVersion: v, outdated };
}
