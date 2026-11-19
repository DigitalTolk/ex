import { useMemo } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { UserGroup, UserGroupDetail, UserGroupSyncStatus } from '@/types/generated';

// User groups ("@oncall"): one per Microsoft 365 department and one per
// squad, made and kept in sync by the server. Every change also arrives as
// usergroup.changed (ChatPage), which invalidates the whole 'usergroups'
// prefix, so every open list and detail follows.

export interface UserGroupPermissions {
  canManage: boolean;
}

const NO_PERMISSIONS: UserGroupPermissions = { canManage: false };

export interface UserGroupPatch {
  handle?: string;
  name?: string;
  description?: string;
}

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

// useUserGroupPermissions says whether the viewer may edit groups (admins).
export function useUserGroupPermissions(): UserGroupPermissions {
  const { data } = useQuery({
    queryKey: queryKeys.userGroupPermissions(),
    queryFn: async () => (await apiFetch<UserGroupPermissions>('/api/v1/usergroup-permissions')) ?? NO_PERMISSIONS,
    staleTime: 60_000,
  });
  return data ?? NO_PERMISSIONS;
}

// useCanManageUserGroups says whether the viewer may edit groups.
export function useCanManageUserGroups() {
  return useUserGroupPermissions().canManage === true;
}

// useUserGroupSyncStatus reads the last directory sweep's group sync and the
// department values it read only partly (admins; enabled for them only).
export function useUserGroupSyncStatus(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.userGroupSync(),
    queryFn: enabled
      ? async () => (await apiFetch<UserGroupSyncStatus>('/api/v1/usergroup-sync')) ?? NO_SYNC_STATUS
      : skipToken,
    staleTime: 60_000,
  });
}

const NO_SYNC_STATUS: UserGroupSyncStatus = { readable: 0, anomalies: { people: 0, counts: {}, examples: [] } };

// checkUserGroupHandle asks whether a handle is free (and well-formed).
export async function checkUserGroupHandle(handle: string): Promise<boolean> {
  const res = await apiFetch<{ available: boolean }>(`/api/v1/usergroup-handles/${encodeURIComponent(handle)}`);
  return !!res?.available;
}

function useInvalidatingMutation<V>(mutationFn: (vars: V) => Promise<UserGroupDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userGroupsAll() }),
  });
}

export function useUpdateUserGroup() {
  return useInvalidatingMutation(({ id, patch }: { id: string; patch: UserGroupPatch }) =>
    apiFetch<UserGroupDetail>(groupPath(id), { method: 'PATCH', body: JSON.stringify(patch) }),
  );
}

// useApproveHeldRemoval lets the next sync apply a group's held removal.
export function useApproveHeldRemoval() {
  return useInvalidatingMutation((id: string) =>
    apiFetch<UserGroupDetail>(`${groupPath(id)}/approve-removal`, { method: 'POST' }),
  );
}

export function useSetUserGroupEnabled() {
  return useInvalidatingMutation(({ id, enabled }: { id: string; enabled: boolean }) =>
    apiFetch<UserGroupDetail>(`${groupPath(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  );
}
