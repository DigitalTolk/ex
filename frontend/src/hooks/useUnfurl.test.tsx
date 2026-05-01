import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUnfurl } from './useUnfurl';
import { ApiError } from '@/lib/api';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  };
});

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('useUnfurl', () => {
  it('returns the preview when the API resolves with one', async () => {
    apiFetchMock.mockResolvedValueOnce({
      url: 'https://example.com',
      title: 'Example',
      description: 'desc',
    });
    const { result } = renderHook(() => useUnfurl('https://example.com'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({
      url: 'https://example.com',
      title: 'Example',
      description: 'desc',
    });
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/v1/unfurl?url=https%3A%2F%2Fexample.com',
    );
  });

  it('normalizes 204 (undefined response) to null', async () => {
    apiFetchMock.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useUnfurl('https://no-meta.com'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('returns null on ApiError (server-side fetch failure)', async () => {
    apiFetchMock.mockRejectedValueOnce(new ApiError(500, 'Boom'));
    const { result } = renderHook(() => useUnfurl('https://broken.example'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('returns null on non-ApiError network failures (no error UI shown)', async () => {
    // Any failure — non-2xx, network drop, malformed JSON — is
    // treated as "no preview". Caller renders nothing rather than
    // an error state.
    apiFetchMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useUnfurl('https://broken.example'), { wrapper: wrap() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('is disabled and returns no data when the URL is null', async () => {
    const { result } = renderHook(() => useUnfurl(null), { wrapper: wrap() });
    // The hook should not fetch.
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(result.current.data).toBeUndefined();
    expect(result.current.fetchStatus).toBe('idle');
  });
});
