import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { User } from '@/types';

// allUsersQuery is the one definition of "load everyone": the roster hook
// (useAllUsers) and the search bar's from: suggestions read the same cache
// entry. It lives outside the hooks modules, which tests mock wholesale.
export function allUsersQuery() {
  return {
    queryKey: queryKeys.allUsers(),
    queryFn: async () => {
      const res = await apiFetch<User[]>('/api/v1/users?all=true');
      return Array.isArray(res) ? res : [];
    },
    staleTime: 5 * 60 * 1000,
  };
}
