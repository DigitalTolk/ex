import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { queryKeys } from '@/lib/query-keys';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import {
  useEntraGroupSearch,
  useLinkPreview,
  useLinkUserGroup,
  useSyncUserGroup,
  useUnlinkUserGroup,
  useUserGroupPermissions,
  checkUserGroupHandle,
  useAddUserGroupMembers,
  useCanManageUserGroups,
  useCreateUserGroup,
  useMyUserGroupIds,
  useRemoveUserGroupMember,
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
        create: useCreateUserGroup(),
        update: useUpdateUserGroup(),
        add: useAddUserGroupMembers(),
        remove: useRemoveUserGroupMember(),
        setEnabled: useSetUserGroupEnabled(),
      }),
      { wrapper },
    );
    await act(async () => {
      await result.current.create.mutateAsync({ handle: 'oncall', name: 'On-call', description: '', memberIds: ['u-1'] });
      await result.current.update.mutateAsync({ id: 'group-1', patch: { name: 'Pager' } });
      await result.current.add.mutateAsync({ id: 'group-1', userIds: ['u-2'] });
      await result.current.remove.mutateAsync({ id: 'group-1', userId: 'u-2' });
      await result.current.setEnabled.mutateAsync({ id: 'group-1', enabled: false });
      await result.current.setEnabled.mutateAsync({ id: 'group-1', enabled: true });
    });
    expect(mockApiFetch.mock.calls).toEqual([
      ['/api/v1/usergroups', { method: 'POST', body: JSON.stringify({ handle: 'oncall', name: 'On-call', description: '', memberIds: ['u-1'] }) }],
      ['/api/v1/usergroups/group-1', { method: 'PATCH', body: JSON.stringify({ name: 'Pager' }) }],
      ['/api/v1/usergroups/group-1/members', { method: 'POST', body: JSON.stringify({ userIds: ['u-2'] }) }],
      ['/api/v1/usergroups/group-1/members/u-2', { method: 'DELETE' }],
      ['/api/v1/usergroups/group-1/disable', { method: 'POST' }],
      ['/api/v1/usergroups/group-1/enable', { method: 'POST' }],
    ]);
    expect(spy).toHaveBeenCalledTimes(6);
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.userGroupsAll() });
  });
});

describe('Microsoft 365 links', () => {
  it('reads both permissions, and none when the answer is missing', async () => {
    mockApiFetch.mockResolvedValueOnce({ canManage: true, canLinkMicrosoft: true });
    const perms = renderHook(() => useUserGroupPermissions(), { wrapper });
    await waitFor(() => expect(perms.result.current).toEqual({ canManage: true, canLinkMicrosoft: true }));
  });

  it('searches Microsoft 365 groups, and not for a blank query', async () => {
    const blank = renderHook(() => useEntraGroupSearch('  '), { wrapper });
    expect(blank.result.current.fetchStatus).toBe('idle');
    mockApiFetch.mockResolvedValueOnce([{ id: 'e-1', displayName: 'On call', kind: 'security' }]).mockResolvedValueOnce(undefined);
    const found = renderHook(() => useEntraGroupSearch(' on call '), { wrapper });
    await waitFor(() => expect(found.result.current.data).toHaveLength(1));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroup-sources/microsoft?q=on%20call');
    const odd = renderHook(() => useEntraGroupSearch('odd'), { wrapper });
    await waitFor(() => expect(odd.result.current.data).toEqual([]));
  });

  it('previews a link for a new or an existing group', async () => {
    const none = renderHook(() => useLinkPreview(undefined), { wrapper });
    expect(none.result.current.fetchStatus).toBe('idle');
    mockApiFetch.mockResolvedValue({ users: 1, toAdd: 1, toRemove: 0, skipped: 0, overLimit: false });
    const fresh = renderHook(() => useLinkPreview('e 1'), { wrapper });
    await waitFor(() => expect(fresh.result.current.data?.toAdd).toBe(1));
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroup-sources/microsoft/e%201/preview');
    const existing = renderHook(() => useLinkPreview('e-1', 'group 1'), { wrapper });
    await waitFor(() => expect(existing.result.current.data).toBeDefined());
    expect(mockApiFetch).toHaveBeenCalledWith('/api/v1/usergroup-sources/microsoft/e-1/preview?groupId=group%201');
  });

  it('links, unlinks and syncs', async () => {
    mockApiFetch.mockResolvedValue(ONCALL);
    const { result } = renderHook(() => ({ link: useLinkUserGroup(), unlink: useUnlinkUserGroup(), sync: useSyncUserGroup() }), { wrapper });
    await act(async () => {
      await result.current.link.mutateAsync({ id: 'group-1', entraGroupId: 'e-1' });
      await result.current.unlink.mutateAsync('group-1');
      await result.current.sync.mutateAsync({ id: 'group-1', applyRemovals: true });
    });
    expect(mockApiFetch.mock.calls).toEqual([
      ['/api/v1/usergroups/group-1/link', { method: 'POST', body: JSON.stringify({ entraGroupId: 'e-1' }) }],
      ['/api/v1/usergroups/group-1/unlink', { method: 'POST' }],
      ['/api/v1/usergroups/group-1/sync', { method: 'POST', body: JSON.stringify({ applyRemovals: true }) }],
    ]);
  });
});
