import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';

// BUILD_VERSION is the version this bundle shipped with — frozen at
// `npm run build` time via the Vite `define` config.
export const BUILD_VERSION: string =
  typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';

const POLL_INTERVAL_MS = 60_000;
const FOCUS_THROTTLE_MS = 5_000;

interface VersionResponse {
  version: string;
}

/**
 * useServerVersion polls /api/v1/version and reports `outdated=true`
 * when the server's running build differs from the one this bundle
 * shipped with — i.e., a deploy has rolled out and the user needs to
 * hard-refresh to pick up the new JS chunks.
 *
 * Polling triggers:
 *   - on mount (immediate fetch so the banner appears within the first
 *     render cycle if the user opened the app on a stale tab)
 *   - every 60s while the tab is visible
 *   - whenever the tab regains focus (catches the common "leave tab open
 *     overnight, deploy happens, return in the morning" case)
 *
 * The hook never auto-reloads — that's the user's choice in the banner.
 */
export function useServerVersion(): {
  serverVersion: string | null;
  outdated: boolean;
} {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const lastCheckRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      lastCheckRef.current = Date.now();
      try {
        const res = await apiFetch<VersionResponse>('/api/v1/version');
        if (!cancelled && res?.version) {
          setServerVersion(res.version);
        }
      } catch {
        // Network blips are not interesting — we'll try again on the
        // next poll. The banner only fires on a *confirmed* mismatch.
      }
    }

    void check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    // Throttle focus-triggered checks: rapid alt-tab cycling can fire
    // several focus events per second and we don't need a re-fetch each
    // time. Once every FOCUS_THROTTLE_MS is plenty.
    const onFocus = () => {
      if (Date.now() - lastCheckRef.current < FOCUS_THROTTLE_MS) return;
      void check();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // We only treat `outdated=true` after we've successfully fetched at
  // least once AND the value differs. A null serverVersion means we
  // haven't heard back yet — silence the banner during that window.
  const outdated =
    serverVersion !== null &&
    serverVersion !== BUILD_VERSION &&
    BUILD_VERSION !== 'dev';

  return { serverVersion, outdated };
}
