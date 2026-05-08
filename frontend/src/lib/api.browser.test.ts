import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, clearAccessToken, getAccessToken, refreshAccessToken, setAccessToken } from './api';

const originalFetch = globalThis.fetch;

describe('apiFetch browser auth recovery', () => {
  beforeEach(() => {
    clearAccessToken();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    clearAccessToken();
    globalThis.fetch = originalFetch;
  });

  it('recovers from a protected API 401 using the refresh cookie after the memory token was cleared', async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: () => Promise.resolve('missing or invalid token'),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ accessToken: 'fresh-after-restart' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve({ channels: ['general'] }),
      } as Response);

    await expect(apiFetch('/api/v1/channels')).resolves.toEqual({ channels: ['general'] });

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, '/auth/token/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    const retryHeaders = vi.mocked(globalThis.fetch).mock.calls[2][1]?.headers as Headers;
    expect(retryHeaders.get('Authorization')).toBe('Bearer fresh-after-restart');
  });

  it('does not discard the current memory token when refresh fails because the server is temporarily down', async () => {
    setAccessToken('token-before-restart');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('connection refused'));

    await expect(refreshAccessToken()).resolves.toBeNull();

    expect(getAccessToken()).toBe('token-before-restart');
  });
});
