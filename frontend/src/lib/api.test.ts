import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const setServerVersionMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useServerVersion', () => ({
  setServerVersion: setServerVersionMock,
}));

import {
  setAccessToken,
  getAccessToken,
  clearAccessToken,
  refreshAccessToken,
  apiFetch,
  ApiError,
} from './api';

describe('access token management', () => {
  afterEach(() => {
    clearAccessToken();
  });

  it('starts with null token', () => {
    clearAccessToken();
    expect(getAccessToken()).toBeNull();
  });

  it('roundtrips set / get / clear', () => {
    setAccessToken('tok-123');
    expect(getAccessToken()).toBe('tok-123');

    clearAccessToken();
    expect(getAccessToken()).toBeNull();
  });

  it('overwrites a previous token', () => {
    setAccessToken('tok-a');
    setAccessToken('tok-b');
    expect(getAccessToken()).toBe('tok-b');
  });
});

describe('apiFetch', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearAccessToken();
    setServerVersionMock.mockReset();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('adds Authorization header when token is set', async () => {
    setAccessToken('my-token');

    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'ok' }),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await apiFetch('/api/v1/test');

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer my-token');
  });

  it('does not add Authorization header when no token', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'ok' }),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await apiFetch('/api/v1/test');

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Authorization')).toBeNull();
  });

  it('throws ApiError on non-ok response', async () => {
    const mockResponse = {
      ok: false,
      status: 404,
      text: () => Promise.resolve('not found'),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await expect(apiFetch('/api/v1/missing')).rejects.toThrow(ApiError);
    await expect(apiFetch('/api/v1/missing')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('captures app version headers even when the API response fails', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      headers: new Headers({ 'X-EX-App-Version': 'server-build-2' }),
      text: () => Promise.resolve('channel unavailable'),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await expect(apiFetch('/api/v1/channels/general')).rejects.toThrow(ApiError);
    expect(setServerVersionMock).toHaveBeenCalledWith('server-build-2');
  });

  it('captures app version headers when token refresh fails before the app shell mounts', async () => {
    const mockResponse = {
      ok: false,
      status: 401,
      headers: new Headers({ 'X-EX-App-Version': 'server-build-3' }),
      json: () => Promise.resolve({ error: 'missing or invalid token' }),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(setServerVersionMock).toHaveBeenCalledWith('server-build-3');
  });

  it('uses structured backend error messages instead of raw JSON', async () => {
    const mockResponse = {
      ok: false,
      status: 409,
      text: () => Promise.resolve(JSON.stringify({
        error: {
          code: 'conflict',
          message: 'channel: a channel with this name already exists',
        },
      })),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await expect(apiFetch('/api/v1/channels')).rejects.toMatchObject({
      status: 409,
      message: 'channel: a channel with this name already exists',
    });
  });

  it('returns undefined for 204 No Content', async () => {
    const mockResponse = {
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error('no body')),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    const result = await apiFetch('/api/v1/delete');
    expect(result).toBeUndefined();
  });

  it('sets Content-Type for string body', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await apiFetch('/api/v1/create', {
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
    });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = call[1]?.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('does not send timezone by default', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await apiFetch('/api/v1/test');

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = call[1]?.headers as Headers;
    expect(headers.get('X-Time-Zone')).toBeNull();
  });

  it('preserves an explicitly provided timezone header', async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    } as Response;

    vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

    await apiFetch('/api/v1/test', { headers: { 'X-Time-Zone': 'Europe/Stockholm' } });

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = call[1]?.headers as Headers;
    expect(headers.get('X-Time-Zone')).toBe('Europe/Stockholm');
  });
});
