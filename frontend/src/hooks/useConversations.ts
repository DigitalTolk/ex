import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { UserConversation, Conversation } from '@/types';

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
