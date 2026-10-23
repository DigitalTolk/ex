import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { User } from '@/types';

// The members directory: everyone, or (from two characters on) the accounts
// matching `query`. A user.updated is patched into it in place
// (lib/user-cache), so the directory follows renames and status changes live.
export function useDirectoryUsers(query: string) {
  return useQuery({
    queryKey: queryKeys.usersDirectory(query),
    queryFn: async () => {
      const res = await apiFetch<User[]>(
        query.length >= 2 ? `/api/v1/users?q=${encodeURIComponent(query)}` : '/api/v1/users',
      );
      return Array.isArray(res) ? res : [];
    },
  });
}

function usePatchDirectoryUser() {
  const queryClient = useQueryClient();
  return (userId: string, patch: Partial<User>) =>
    queryClient.setQueriesData<User[]>({ queryKey: queryKeys.usersDirectory() }, (prev) =>
      prev?.map((u) => (u.id === userId ? { ...u, ...patch } : u)),
    );
}

// An admin changes an account's system role.
export function useSetUserRole() {
  const patchUser = usePatchDirectoryUser();
  return useMutation({
    mutationFn: (vars: { userId: string; role: User['systemRole'] }) =>
      apiFetch<void>(`/api/v1/users/${vars.userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: vars.role }),
      }),
    onSuccess: (_res, vars) => patchUser(vars.userId, { systemRole: vars.role }),
  });
}

// An admin deactivates or reactivates an account — any account but their
// own (the server refuses self-deactivation). Deactivating ends the
// account's sessions and automations server-side.
export function useSetUserStatus() {
  const patchUser = usePatchDirectoryUser();
  return useMutation({
    mutationFn: (vars: { userId: string; deactivated: boolean }) =>
      apiFetch<void>(`/api/v1/users/${vars.userId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ deactivated: vars.deactivated }),
      }),
    onSuccess: (_res, vars) => patchUser(vars.userId, { status: vars.deactivated ? 'deactivated' : 'active' }),
  });
}
