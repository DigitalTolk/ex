import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCreateRunnerGrant, useRevokeRunnerToken, useRunnerTokens } from '@/hooks/useRunnerTokens';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { qc, Wrapper };
}

const install = { id: 'rt1', label: 'mac', createdAt: '2026-10-05T00:00:00Z', expiresAt: '2026-11-04T00:00:00Z' };

describe('useRunnerTokens', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('lists the caller’s connected runners', async () => {
    mockApiFetch.mockResolvedValue({ runners: [install] });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useRunnerTokens(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.data).toEqual([install]));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens');
  });

  it('reads an empty or missing body as no runners', async () => {
    for (const body of [undefined, {}]) {
      mockApiFetch.mockResolvedValue(body);
      const { Wrapper } = wrap();
      const { result } = renderHook(() => useRunnerTokens(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.data).toEqual([]));
    }
  });

  it('does not fetch while disabled', () => {
    const { Wrapper } = wrap();
    renderHook(() => useRunnerTokens(false), { wrapper: Wrapper });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});

describe('useRevokeRunnerToken', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('DELETEs the install and refreshes the list', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useRevokeRunnerToken(), { wrapper: Wrapper });
    result.current.mutate('rt/1');
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['runner-tokens'] }));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/rt%2F1', { method: 'DELETE' });
  });
});

describe('useCreateRunnerGrant', () => {
  beforeEach(() => mockApiFetch.mockReset());

  it('POSTs the challenge and machine name, returning the one-time code', async () => {
    mockApiFetch.mockResolvedValue({ code: 'one-time', expiresAt: 'soon' });
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCreateRunnerGrant(), { wrapper: Wrapper });
    const res = await result.current.mutateAsync({ challenge: 'chal', label: 'mac' });
    expect(res).toEqual({ code: 'one-time', expiresAt: 'soon' });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/runner-tokens/grants', {
      method: 'POST',
      body: JSON.stringify({ challenge: 'chal', label: 'mac' }),
    });
  });
});
