import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useFrequentPeople } from './useFrequentPeople';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useFrequentPeople', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('maps the ranking to person → rank, most frequent first', async () => {
    vi.mocked(apiFetch).mockResolvedValue(['u-2', 'u-7', 42] as never);
    const { result } = renderHook(() => useFrequentPeople(true), { wrapper });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('u-2')).toBe(0);
    expect(result.current.get('u-7')).toBe(1);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/api/v1/users/me/frequent-people?limit=50');
  });

  it('is empty for a malformed answer, and asks nothing while disabled', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ not: 'a list' } as never);
    const { result } = renderHook(() => useFrequentPeople(true), { wrapper });
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.size).toBe(0));

    vi.mocked(apiFetch).mockClear();
    const off = renderHook(() => useFrequentPeople(false), { wrapper });
    expect(off.result.current.size).toBe(0);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
});
