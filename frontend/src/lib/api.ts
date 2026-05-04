let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

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

export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const res = await fetch('/auth/token/refresh', {
          method: 'POST',
          credentials: 'include',
        });
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
        clearAccessToken();
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

  if (res.status === 401 && accessToken) {
    const refreshedToken = await refreshAccessToken();
    if (refreshedToken) {
      headers.set('Authorization', `Bearer ${accessToken}`);
      const retry = await fetch(path, {
        ...options,
        headers,
        credentials: 'include',
      });
      if (!retry.ok) {
        throw new ApiError(retry.status, await errorMessageFromResponse(retry));
      }
      return retry.json();
    }
    clearAccessToken();
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    throw new ApiError(res.status, await errorMessageFromResponse(res));
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json();
}
