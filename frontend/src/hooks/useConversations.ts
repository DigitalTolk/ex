import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { UserConversation, Conversation, User } from '@/types';

export function useUserConversations() {
  return useQuery({
    queryKey: queryKeys.userConversations(),
    queryFn: () =>
      apiFetch<UserConversation[]>('/api/v1/conversations'),
  });
}

export function useConversation(conversationId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.conversation(conversationId ?? ''),
    queryFn: () =>
      apiFetch<Conversation>(`/api/v1/conversations/${conversationId}`),
    enabled: !!conversationId,
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      type: 'dm' | 'group';
      participantIDs: string[];
      name?: string;
    }) =>
      apiFetch<Conversation>('/api/v1/conversations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.userConversations() });
    },
  });
}

export function useSearchUsers(query: string) {
  return useQuery({
    queryKey: queryKeys.searchUsers(query),
    queryFn: () =>
      apiFetch<{ id: string; email: string; displayName: string }[]>(
        `/api/v1/users?q=${encodeURIComponent(query)}`,
      ),
    enabled: query.length >= 2,
  });
}

// useAllUsers loads the entire roster into the React Query cache so
// the mention popup can filter client-side without a per-keystroke
// round-trip. `?all=true` flips the handler into the
// paginate-internally-and-return-everything path. The list mutates
// rarely (joins/leaves, profile edits); a 5-minute stale time keeps
// it fresh enough for the UX without thrashing the network.
export function useAllUsers() {
  return useQuery({
    queryKey: queryKeys.allUsers(),
    queryFn: () => apiFetch<User[]>('/api/v1/users?all=true'),
    staleTime: 5 * 60 * 1000,
  });
}
