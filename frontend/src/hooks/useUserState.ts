import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { UserState } from '@/types';

const EMPTY_USER_STATE: UserState = {
  channelNotifications: [],
  threadNotifications: [],
  threadSeen: {},
  hiddenConversations: [],
};

export function useUserState(options?: { enabled?: boolean }) {
  return useQuery<UserState>({
    queryKey: queryKeys.userState(),
    queryFn: async () => {
      const state = await apiFetch<UserState>('/api/v1/user-state');
      return {
        channelNotifications: state.channelNotifications ?? [],
        threadNotifications: state.threadNotifications ?? [],
        threadSeen: state.threadSeen ?? {},
        hiddenConversations: state.hiddenConversations ?? [],
      };
    },
    enabled: options?.enabled ?? true,
    staleTime: 15_000,
    placeholderData: EMPTY_USER_STATE,
  });
}

export function useMarkThreadSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { parentID: string; parentType: string; threadRootID: string }) => {
      const parentType = target.parentType === 'channel' ? 'channels' : 'conversations';
      return apiFetch<void>(
        `/api/v1/user-state/threads/${parentType}/${encodeURIComponent(target.parentID)}/${encodeURIComponent(target.threadRootID)}/seen`,
        { method: 'PUT' },
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.userState() });
      qc.invalidateQueries({ queryKey: queryKeys.userThreads() });
    },
  });
}
