import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useUsersBatch } from './useUsersBatch';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

describe('useUsersBatch', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  // /users/batch refuses more than 100 ids, so a larger set (the Activity page
  // can name hundreds of actors) must split — one oversized request used to
  // fail and leave every name as "Someone".
  it('splits more than 100 ids into batches and merges the users', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_path, options) => {
      const { ids } = JSON.parse(String(options?.body)) as { ids: string[] };
      if (ids.length > 100) throw new Error('400');
      return ids.map((id) => ({ id, displayName: `User ${id}` }));
    });
    const ids = Array.from({ length: 250 }, (_, i) => `u-${String(i).padStart(3, '0')}`);
    const { result } = renderHook(() => useUsersBatch([...ids, 'u-000']), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(3);
    const sizes = vi.mocked(apiFetch).mock.calls.map(([, o]) => (JSON.parse(String(o?.body)) as { ids: string[] }).ids.length);
    expect(sizes).toEqual([100, 100, 50]);
    expect(result.current.map.size).toBe(250);
    expect(result.current.map.get('u-249')?.displayName).toBe('User u-249');
  });

  it('skips a batch whose response is not a list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(null);
    const { result } = renderHook(() => useUsersBatch(['u-1']), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.map.size).toBe(0);
  });

  it('does not fetch for no ids', () => {
    renderHook(() => useUsersBatch([]), { wrapper });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
