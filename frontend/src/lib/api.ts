import { setServerVersion } from '@/hooks/useServerVersion';

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

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function errorMessageFromResponse(res: Response): Promise<string> {
  const text = await res.text();
  if (!text) return res.statusText || `Request failed (${res.status})`;
  try {
    const data = JSON.parse(text) as {
      error?: string | { message?: string; code?: string };
      message?: string;
    };
    if (typeof data.error === 'string') return data.error;
    if (data.error?.message) return data.error.message;
    if (data.message) return data.message;
  } catch {
    // Plain-text error response.
  }
  return text;
}

export function captureServerVersion(res: Response): void {
  const version = res.headers?.get(APP_VERSION_HEADER);
  if (version) setServerVersion(version);
}

export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch('/auth/token/refresh', {
          method: 'POST',
          credentials: 'include',
        });
        captureServerVersion(res);
        if (!res.ok) {
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
      } catch {
        return null;
      }
    })().finally(() => {
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
        throw new ApiError(retry.status, await errorMessageFromResponse(retry));
      }
      return retry.json();
    }
    clearAccessToken();
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    /* istanbul ignore next -- a 401 on the first response is fully handled by the refresh branch above (L106), which either retries or throws; control never reaches here with status 401, so this guard is defensive. */
    if (res.status === 401) {
      clearAccessToken();
    }
    throw new ApiError(res.status, await errorMessageFromResponse(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}
