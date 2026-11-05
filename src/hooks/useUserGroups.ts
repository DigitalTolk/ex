import { useMemo } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { UserGroup, UserGroupDetail } from '@/types/generated';

// User groups ("@oncall"): a named set of people mentioned together. Every
// change also arrives as usergroup.changed (ChatPage), which invalidates the
// whole 'usergroups' prefix, so every open list and detail follows.

export interface UserGroupInput {
  handle: string;
  name: string;
  description: string;
  memberIds: string[];
}

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

// useCanManageUserGroups says whether the viewer may create and edit groups
// (admins, or every member when the workspace allows it).
export function useCanManageUserGroups(enabled = true) {
  const { data } = useQuery({
    queryKey: queryKeys.userGroupPermissions(),
    queryFn: async () => (await apiFetch<{ canManage: boolean }>('/api/v1/usergroup-permissions')) ?? { canManage: false },
    enabled,
    staleTime: 60_000,
  });
  return data?.canManage === true;
}

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

export function useCreateUserGroup() {
  return useInvalidatingMutation((input: UserGroupInput) =>
    apiFetch<UserGroupDetail>('/api/v1/usergroups', { method: 'POST', body: JSON.stringify(input) }),
  );
}

export function useUpdateUserGroup() {
  return useInvalidatingMutation(({ id, patch }: { id: string; patch: UserGroupPatch }) =>
    apiFetch<UserGroupDetail>(groupPath(id), { method: 'PATCH', body: JSON.stringify(patch) }),
  );
}

export function useAddUserGroupMembers() {
  return useInvalidatingMutation(({ id, userIds }: { id: string; userIds: string[] }) =>
    apiFetch<UserGroupDetail>(`${groupPath(id)}/members`, { method: 'POST', body: JSON.stringify({ userIds }) }),
  );
}

export function useRemoveUserGroupMember() {
  return useInvalidatingMutation(({ id, userId }: { id: string; userId: string }) =>
    apiFetch<UserGroupDetail>(`${groupPath(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  );
}

export function useSetUserGroupEnabled() {
  return useInvalidatingMutation(({ id, enabled }: { id: string; enabled: boolean }) =>
    apiFetch<UserGroupDetail>(`${groupPath(id)}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' }),
  );
}
