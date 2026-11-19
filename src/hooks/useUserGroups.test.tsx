import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryKeys } from '@/lib/query-keys';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import {
  useUserGroupPermissions,
  useUserGroupSyncStatus,
  checkUserGroupHandle,
  useCanManageUserGroups,
  useMyUserGroupIds,
  useSetUserGroupEnabled,
  useUpdateUserGroup,
  useUserGroup,
  useUserGroups,
  useUserGroupsForUser,
} from './useUserGroups';

const ONCALL = { id: 'group-1', handle: 'oncall', name: 'On-call', memberIds: ['u-1'] };

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  mockApiFetch.mockReset();
});

describe('user-group queries', () => {
  it('lists enabled groups, or all of them', async () => {
    mockApiFetch.mockResolvedValue([ONCALL]);
    const enabled = renderHook(() => useUserGroups(), { wrapper });
    await waitFor(() => expect(enabled.result.current.data).toEqual([ONCALL]));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroups');
    const all = renderHook(() => useUserGroups(true), { wrapper });
    await waitFor(() => expect(all.result.current.data).toEqual([ONCALL]));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroups?includeDisabled=true');
  });

  it('reads a non-array answer as no groups', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const list = renderHook(() => useUserGroups(), { wrapper });
    const forUser = renderHook(() => useUserGroupsForUser('u-1'), { wrapper });
    await waitFor(() => expect(list.result.current.data).toEqual([]));
    await waitFor(() => expect(forUser.result.current.data).toEqual([]));
  });

  it('reads one group, and nothing without an id', async () => {
    mockApiFetch.mockResolvedValue(ONCALL);
    const one = renderHook(() => useUserGroup('group-1'), { wrapper });
    await waitFor(() => expect(one.result.current.data).toEqual(ONCALL));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroups/group-1');
    const none = renderHook(() => useUserGroup(undefined), { wrapper });
    expect(none.result.current.fetchStatus).toBe('idle');
  });

  it("lists a person's groups and the viewer's group ids", async () => {
    mockApiFetch.mockResolvedValue([ONCALL]);
    const groups = renderHook(() => useUserGroupsForUser('u 1'), { wrapper });
    await waitFor(() => expect(groups.result.current.data).toEqual([ONCALL]));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/users/u%201/usergroups');

    const mine = renderHook(() => useMyUserGroupIds('u-1'), { wrapper });
    await waitFor(() => expect(mine.result.current.has('group-1')).toBe(true));

    const nobody = renderHook(() => useMyUserGroupIds(undefined), { wrapper });
    expect(nobody.result.current.size).toBe(0);
    const anonymous = renderHook(() => useUserGroupsForUser(undefined), { wrapper });
    expect(anonymous.result.current.fetchStatus).toBe('idle');
  });

  it('says whether the viewer may manage groups', async () => {
    mockApiFetch.mockResolvedValueOnce({ canManage: true });
    const yes = renderHook(() => useCanManageUserGroups(), { wrapper });
    await waitFor(() => expect(yes.result.current).toBe(true));

    qc.clear();
    mockApiFetch.mockResolvedValueOnce(undefined);
    const no = renderHook(() => useCanManageUserGroups(), { wrapper });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledTimes(2));
    expect(no.result.current).toBe(false);
  });

  it('checks a handle', async () => {
    mockApiFetch.mockResolvedValueOnce({ available: true }).mockResolvedValueOnce(undefined);
    await expect(checkUserGroupHandle('on call')).resolves.toBe(true);
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroup-handles/on%20call');
    await expect(checkUserGroupHandle('x')).resolves.toBe(false);
  });
});

describe('user-group mutations', () => {
  it('each sends its request and refreshes every group query', async () => {
    mockApiFetch.mockResolvedValue(ONCALL);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(
      () => ({
        update: useUpdateUserGroup(),
        setEnabled: useSetUserGroupEnabled(),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.update.mutateAsync({ id: 'group-1', patch: { name: 'Pager' } });
      await result.current.setEnabled.mutateAsync({ id: 'group-1', enabled: false });
      await result.current.setEnabled.mutateAsync({ id: 'group-1', enabled: true });
    });
    expect(mockApiFetch.mock.calls).toEqual([
      ['/api/v1/usergroups/group-1', { method: 'PATCH', body: JSON.stringify({ name: 'Pager' }) }],
      ['/api/v1/usergroups/group-1/disable', { method: 'POST' }],
      ['/api/v1/usergroups/group-1/enable', { method: 'POST' }],
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.userGroupsAll() });
  });
});

describe('the sync status', () => {
  it('reads the permissions, and none when the answer is missing', async () => {
    mockApiFetch.mockResolvedValueOnce({ canManage: true });
    const perms = renderHook(() => useUserGroupPermissions(), { wrapper });
    await waitFor(() => expect(perms.result.current).toEqual({ canManage: true }));
  });

  it('reads the last sync for admins only, and an empty one when the answer is missing', async () => {
    const off = renderHook(() => useUserGroupSyncStatus(false), { wrapper });
    expect(off.result.current.fetchStatus).toBe('idle');
    expect(mockApiFetch).not.toHaveBeenCalled();

    const status = { lastSyncedAt: '2026-11-19T10:00:00Z', readable: 4, anomalies: { people: 0, counts: {}, examples: [] } };
    mockApiFetch.mockResolvedValueOnce(status);
    const on = renderHook(() => useUserGroupSyncStatus(true), { wrapper });
    await waitFor(() => expect(on.result.current.data).toEqual(status));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroup-sync');

    qc.clear();
    mockApiFetch.mockResolvedValueOnce(undefined);
    const empty = renderHook(() => useUserGroupSyncStatus(true), { wrapper });
    await waitFor(() => expect(empty.result.current.data?.anomalies.examples).toEqual([]));
  });
});
