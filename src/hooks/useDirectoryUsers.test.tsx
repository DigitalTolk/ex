import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDirectoryUsers, useSetUserRole, useSetUserStatus } from './useDirectoryUsers';
import { queryKeys } from '@/lib/query-keys';
import type { User } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

const bob: User = { id: 'u-2', email: 'b@x.com', displayName: 'Bob', systemRole: 'member', status: 'active' };

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe('useDirectoryUsers', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('lists everyone under two characters and searches from two on', async () => {
    vi.mocked(apiFetch).mockResolvedValue([bob]);
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ q }) => useDirectoryUsers(q), { wrapper, initialProps: { q: 'b' } });
    await waitFor(() => expect(result.current.data).toEqual([bob]));
    expect(apiFetch).toHaveBeenLastCalledWith('/api/v1/users');

    rerender({ q: 'bo b' });
    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith('/api/v1/users?q=bo%20b'));
  });

  it('reads a non-array body as an empty list', async () => {
    vi.mocked(apiFetch).mockResolvedValue(null);
    const { wrapper } = setup();
    const { result } = renderHook(() => useDirectoryUsers(''), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });
});

describe('directory user mutations', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('a role change patches every cached directory list, skipping lists still loading', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { qc, wrapper } = setup();
    qc.setQueryData(queryKeys.usersDirectory(''), [bob]);
    // A list whose first load is still out has no rows to patch.
    qc.getQueryCache().build(qc, { queryKey: queryKeys.usersDirectory('zz') });
    const { result } = renderHook(() => useSetUserRole(), { wrapper });
    act(() => result.current.mutate({ userId: 'u-2', role: 'admin' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/users/u-2/role', {
      method: 'PATCH',
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(qc.getQueryData<User[]>(queryKeys.usersDirectory(''))?.[0].systemRole).toBe('admin');
    expect(qc.getQueryData(queryKeys.usersDirectory('zz'))).toBeUndefined();
  });

  it('deactivating and reactivating flips the cached status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { qc, wrapper } = setup();
    qc.setQueryData(queryKeys.usersDirectory(''), [bob, { ...bob, id: 'u-3' }]);
    const { result } = renderHook(() => useSetUserStatus(), { wrapper });

    act(() => result.current.mutate({ userId: 'u-2', deactivated: true }));
    await waitFor(() =>
      expect(qc.getQueryData<User[]>(queryKeys.usersDirectory(''))?.map((u) => u.status)).toEqual(['deactivated', 'active']),
    );

    act(() => result.current.mutate({ userId: 'u-2', deactivated: false }));
    await waitFor(() =>
      expect(qc.getQueryData<User[]>(queryKeys.usersDirectory(''))?.map((u) => u.status)).toEqual(['active', 'active']),
    );
  });
});
