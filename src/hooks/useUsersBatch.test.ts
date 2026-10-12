import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useUsersBatch } from './useUsersBatch';
import { queryKeys } from '@/lib/query-keys';

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

  // A set that grows by one person — a new reaction in the Activity list —
  // fetches that one person; everyone already known is reused, not refetched.
  it('fetches only the ids no fresh batch already holds', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_path, options) => {
      const { ids } = JSON.parse(String(options?.body)) as { ids: string[] };
      return ids.map((id) => ({ id, displayName: `User ${id}` }));
    });
    const bodies = () => vi.mocked(apiFetch).mock.calls.map(([, o]) => (JSON.parse(String(o?.body)) as { ids: string[] }).ids);
    const { result, rerender } = renderHook(({ ids }) => useUsersBatch(ids), { wrapper, initialProps: { ids: ['u-a', 'u-b'] } });
    await waitFor(() => expect(result.current.map.size).toBe(2));

    rerender({ ids: ['u-a', 'u-b', 'u-c'] });
    await waitFor(() => expect(result.current.map.size).toBe(3));
    expect(bodies()).toEqual([['u-a', 'u-b'], ['u-c']]);
    expect(result.current.map.get('u-a')?.displayName).toBe('User u-a');

    // A subset of what's known needs no request at all.
    rerender({ ids: ['u-c', 'u-a'] });
    await waitFor(() => expect(result.current.map.size).toBe(2));
    expect(bodies()).toHaveLength(2);
  });

  // A user.updated invalidates every batch, and a batch past its stale time is
  // old news: neither is reused, so a renamed user shows the new name.
  it('does not reuse invalidated or expired batches', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_path, options) => {
      const { ids } = JSON.parse(String(options?.body)) as { ids: string[] };
      return ids.map((id) => ({ id, displayName: `Fresh ${id}` }));
    });
    client.setQueryData(queryKeys.usersBatch(['u-old']), [{ id: 'u-old', displayName: 'Old' }], { updatedAt: Date.now() - 10 * 60_000 });
    client.setQueryData(queryKeys.usersBatch(['u-inv']), [{ id: 'u-inv', displayName: 'Old' }]);
    await client.invalidateQueries({ queryKey: queryKeys.usersBatch(['u-inv']) });

    const { result } = renderHook(() => useUsersBatch(['u-old', 'u-inv']), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const sent = vi.mocked(apiFetch).mock.calls.map(([, o]) => (JSON.parse(String(o?.body)) as { ids: string[] }).ids);
    expect(sent).toEqual([['u-inv', 'u-old']]);
    expect(result.current.map.get('u-old')?.displayName).toBe('Fresh u-old');
  });
});
