import { useMemo } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { UserGroup, UserGroupDetail, UserGroupSyncStatus } from '@/types/generated';

// User groups ("@oncall"): the Microsoft 365 security groups in one parent
// group, made and kept in sync by the server. Every change also arrives as
// usergroup.changed (ChatPage), which invalidates the whole 'usergroups'
// prefix, so every open list and detail follows; a sync starting or ending
// arrives as usergroup.sync.

export interface UserGroupPermissions {
  canManage: boolean;
}

const NO_PERMISSIONS: UserGroupPermissions = { canManage: false };

const groupPath = (id: string) => `/api/v1/usergroups/${encodeURIComponent(id)}`;

export function useUserGroups(includeDisabled = false, enabled = true) {
  return useQuery({
    queryKey: queryKeys.userGroups(includeDisabled),
    queryFn: async () => {
      const res = await apiFetch<UserGroup[]>(`/api/v1/usergroups${includeDisabled ? '?includeDisabled=true' : ''}`);
      return Array.isArray(res) ? res : [];
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useUserGroup(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.userGroup(id ?? ''),
    queryFn: id ? () => apiFetch<UserGroupDetail>(groupPath(id)) : skipToken,
    staleTime: 60_000,
  });
}

export function useUserGroupsForUser(userId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.userGroupsForUser(userId ?? ''),
    queryFn: userId
      ? async () => {
          const res = await apiFetch<UserGroup[]>(`/api/v1/users/${encodeURIComponent(userId)}/usergroups`);
          return Array.isArray(res) ? res : [];
        }
      : skipToken,
  });
}

const NO_GROUP_IDS: ReadonlySet<string> = new Set();

// useMyUserGroupIds is the set of enabled groups userId belongs to — what
// highlights a group's pill for its members.
export function useMyUserGroupIds(userId: string | undefined): ReadonlySet<string> {
  const { data } = useUserGroupsForUser(userId);
  return useMemo(() => (data ? new Set(data.map((g) => g.id)) : NO_GROUP_IDS), [data]);
}

// useUserGroupPermissions says whether the viewer may manage groups (admins).
export function useUserGroupPermissions(): UserGroupPermissions {
  const { data } = useQuery({
    queryKey: queryKeys.userGroupPermissions(),
    queryFn: async () => (await apiFetch<UserGroupPermissions>('/api/v1/usergroup-permissions')) ?? NO_PERMISSIONS,
    staleTime: 60_000,
  });
  return data ?? NO_PERMISSIONS;
}

// useCanManageUserGroups says whether the viewer may manage groups.
export function useCanManageUserGroups() {
  return useUserGroupPermissions().canManage === true;
}

const SYNC_STATUS_PATH = '/api/v1/usergroup-sync';

// useUserGroupSyncStatus reads how the sync went (admins; enabled for them
// only). While a sync runs it also polls, in case an event is missed.
export function useUserGroupSyncStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.userGroupSync(),
    queryFn: enabled ? async () => (await apiFetch<UserGroupSyncStatus>(SYNC_STATUS_PATH)) ?? NO_SYNC_STATUS : skipToken,
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.running ? 3_000 : false),
  });
}

const NO_SYNC_STATUS: UserGroupSyncStatus = { configured: false, intervalMinutes: 0, running: false, skipped: [] };

// useSyncUserGroupsNow starts a sync (admins). Right after a run the server
// answers 429 with the status, which shows the cooldown like any status.
export function useSyncUserGroupsNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      try {
        return await apiFetch<UserGroupSyncStatus>(SYNC_STATUS_PATH, { method: 'POST' });
      } catch (e) {
        if (e instanceof ApiError && e.status === 429 && e.payload) return e.payload as UserGroupSyncStatus;
        throw e;
      }
    },
    onSuccess: (status) => {
      if (status) qc.setQueryData(queryKeys.userGroupSync(), status);
    },
  });
}

function useInvalidatingMutation<V>(mutationFn: (vars: V) => Promise<UserGroupDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userGroupsAll() }),
  });
}

export function useSetUserGroupEnabled() {
  return useInvalidatingMutation(({ id, enabled }: { id: string; enabled: boolean }) =>
    apiFetch<UserGroupDetail>(`${groupPath(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  );
}
