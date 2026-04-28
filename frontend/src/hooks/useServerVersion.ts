import { useEffect, useSyncExternalStore } from 'react';
import { APP_VERSION_META } from '@/lib/version-meta';

// BUILD_VERSION reads `<meta name="app-version">` once on module load —
// it's whatever the server stamped into the same HTML that delivered
// this bundle, so the meta tag and the bundle always match. In dev (no
// meta tag), BUILD_VERSION is 'dev' and the banner stays suppressed.
function readBootVersion(): string {
  if (typeof document === 'undefined') return 'dev';
  const tag = document.querySelector(`meta[name="${APP_VERSION_META}"]`);
  return tag?.getAttribute('content') || 'dev';
}

export const BUILD_VERSION: string = readBootVersion();

let serverVersion: string | null = null;
const subscribers = new Set<() => void>();

export function setServerVersion(v: string): void {
  if (!v || v === serverVersion) return;
  serverVersion = v;
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

// Cached ETag from the previous /api/v1/version response. Sending it
// back as If-None-Match makes the server resolve the steady-state poll
// to a 0-byte 304 instead of a JSON payload.
let lastETag: string | null = null;

let pollerStarted = false;
function startPoller(): void {
  if (pollerStarted) return;
  pollerStarted = true;
  if (typeof window === 'undefined') return;
  const tick = async () => {
    try {
      const headers: HeadersInit = {};
      if (lastETag) headers['If-None-Match'] = lastETag;
      const res = await fetch('/api/v1/version', { headers, credentials: 'include' });
      if (res.status === 304) return;
      if (!res.ok) return;
      const etag = res.headers.get('ETag');
      if (etag) lastETag = etag;
      const data = (await res.json()) as { version?: string };
      if (data?.version) setServerVersion(data.version);
    } catch {
      // Network blip — retry on next tick. A failed poll never surfaces
      // the banner; that's deliberate.
    }
  };
  window.addEventListener('focus', tick);
  void tick();
  window.setInterval(tick, POLL_INTERVAL_MS);
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
  const outdated = v !== null && v !== BUILD_VERSION && BUILD_VERSION !== 'dev';
  return { serverVersion: v, outdated };
}
