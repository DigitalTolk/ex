import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setAccessToken,
  clearAccessToken,
  apiFetch,
  ApiError,
} from './api';

const originalFetch = globalThis.fetch;

describe('apiFetch - 401 refresh flow', () => {
  beforeEach(() => {
    clearAccessToken();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('retries with new token after successful refresh on 401', async () => {
    setAccessToken('expired-token');

    // First call returns 401
    // Second call (refresh) returns new token
    // Third call (retry) returns success
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: 'new-token' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: 'success' }),
      } as Response);

    const result = await apiFetch('/api/v1/test');
    expect(result).toEqual({ data: 'success' });

    // Should have made 3 fetch calls: original, refresh, retry
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('throws 401 and clears token when refresh fails', async () => {
    setAccessToken('expired-token');

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({}),
      } as Response);

    await expect(apiFetch('/api/v1/test')).rejects.toThrow(ApiError);
    await expect(apiFetch('/api/v1/test2')).rejects.toThrow(); // token was cleared
  });

  it('does not retry refresh when there is no token', async () => {
    // No token set
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    } as Response);

    await expect(apiFetch('/api/v1/test')).rejects.toThrow(ApiError);
    // Only 1 call: no refresh attempt
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError when retry after refresh returns non-ok', async () => {
    setAccessToken('expired-token');

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ accessToken: 'new-token' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      } as Response);

    await expect(apiFetch('/api/v1/test')).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('apiFetch - tryRefreshToken edge cases', () => {
  beforeEach(() => {
    clearAccessToken();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('handles refresh endpoint throwing an error', async () => {
    setAccessToken('expired-token');

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      } as Response)
      .mockRejectedValueOnce(new Error('Network error'));

    await expect(apiFetch('/api/v1/test')).rejects.toThrow(ApiError);
  });

  it('handles refresh returning ok but no accessToken', async () => {
    setAccessToken('expired-token');

    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}), // no accessToken field
      } as Response);

    await expect(apiFetch('/api/v1/test')).rejects.toThrow(ApiError);
  });
});
