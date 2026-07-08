import { setServerVersion } from '@/hooks/useServerVersion';
import { notifyAuthInvalid } from '@/lib/auth-events';

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
const APP_VERSION_HEADER = 'X-EX-App-Version';

export function setAccessToken(token: string) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function clearAccessToken() {
  accessToken = null;
}

export class ApiError extends Error {
  status: number;
  // Parsed JSON body of the error response, when there was one. Lets
  // protocol-aware callers (e.g. the drafts 409 reconcile) read structured
  // fields like `current` without a second request.
  payload?: unknown;

  constructor(status: number, message: string, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function apiErrorFromResponse(res: Response): Promise<ApiError> {
  const text = await res.text();
  if (!text) {
    return new ApiError(res.status, res.statusText || `Request failed (${res.status})`);
  }
  let message = text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
    const data = payload as {
      error?: string | { message?: string; code?: string };
      message?: string;
    };
    if (typeof data.error === 'string') message = data.error;
    else if (data.error?.message) message = data.error.message;
    else if (data.message) message = data.message;
  } catch {
    // Plain-text error response.
  }
  return new ApiError(res.status, message, payload);
}

export function captureServerVersion(res: Response): void {
  const version = res.headers?.get(APP_VERSION_HEADER);
  if (version) setServerVersion(version);
}

// Bound on the refresh request. Browser fetch has NO default timeout, and the
// single-flight promise below is shared by the app boot path, every 401 retry,
// and the WS reconnect — one request that never settles (half-open TCP after a
// mobile webview resume, server mid-restart) used to wedge them all forever
// and leave the app on a blank boot screen until force-kill.
const REFRESH_TIMEOUT_MS = 10_000;

// Resolves the new access token, or null when the server DEFINITIVELY rejected
// the session (it answered and said no). Rejects on network-level failure
// (offline, timeout, server unreachable) — the session may still be valid, so
// callers must retry/back off instead of treating it as a logout.
export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const res = await fetch('/auth/token/refresh', {
        method: 'POST',
        credentials: 'include',
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      captureServerVersion(res);
      if (!res.ok) {
        // A 5xx here is a gateway/proxy answering for a backend that
        // couldn't (server mid-restart, Cloudflare 52x) — not a session
        // verdict. Reject like a network failure so callers retry instead
        // of bouncing a still-valid session to the login page.
        if (res.status >= 500) {
          throw new ApiError(res.status, 'token refresh unavailable');
        }
        clearAccessToken();
        return null;
      }
      const data = await res.json();
      if (data.accessToken) {
        setAccessToken(data.accessToken);
        return data.accessToken;
      }
      clearAccessToken();
      return null;
    })().finally(() => {
      // Always release the single-flight slot — on rejection too, so a failed
      // attempt can never poison every future refresh on this page.
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);

  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  if (
    options.body &&
    typeof options.body === 'string' &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
  });
  captureServerVersion(res);

  if (res.status === 401) {
    // A network-level refresh failure REJECTS here and propagates like any
    // other fetch error — deliberately not caught: only a definitive null
    // (the server answered and rejected the session) may reach the
    // notifyAuthInvalid logout below. Treating a connectivity blip as a
    // terminal session used to log people out on flaky networks.
    const refreshedToken = await refreshAccessToken();
    if (refreshedToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
      const retry = await fetch(path, {
        ...options,
        headers,
        credentials: 'include',
      });
      captureServerVersion(retry);
      if (!retry.ok) {
        throw await apiErrorFromResponse(retry);
      }
      return retry.json();
    }
    clearAccessToken();
    // The refresh token is gone/revoked → the session is terminally invalid.
    // Broadcast so AuthContext can drop the user and route to /login, instead
    // of leaving a "logged-in" shell whose every query silently 401s.
    notifyAuthInvalid();
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    /* istanbul ignore next -- a 401 on the first response is fully handled by the refresh branch above (L106), which either retries or throws; control never reaches here with status 401, so this guard is defensive. */
    if (res.status === 401) {
      clearAccessToken();
    }
    throw await apiErrorFromResponse(res);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}
