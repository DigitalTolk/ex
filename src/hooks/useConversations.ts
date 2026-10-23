import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { wsLiveQueryOptions } from '@/lib/query-client';
import { showToast } from '@/lib/toast';
import type { UserConversation, Conversation, User, UserStatus } from '@/types';

// select narrows what the caller subscribes to (see useUserChannels).
export function useUserConversations<T = UserConversation[]>(options?: {
  enabled?: boolean;
  select?: (rows: UserConversation[]) => T;
}) {
  return useQuery({
    queryKey: queryKeys.userConversations(),
    queryFn: async () => {
      const res = await apiFetch<UserConversation[]>('/api/v1/conversations');
      return Array.isArray(res) ? res : [];
    },
    ...wsLiveQueryOptions,
    enabled: options?.enabled ?? true,
    select: options?.select,
  });
}

export function useConversation(conversationId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.conversation(conversationId ?? ''),
    // Coerce a 204/empty body to null — a queryFn must never resolve undefined.
    queryFn: async () =>
      (await apiFetch<Conversation>(`/api/v1/conversations/${conversationId}`)) ?? null,
    enabled: !!conversationId,
  });
}

// useOpenDM is THE shared "message this person" affordance — the SearchBar
// person rows, the search-results People tab, and the directory all open a
// DM through here. Success navigates to the conversation (running the
// caller's onSuccess first so it can clear its own UI state); failure is
// loud and non-destructive: an error toast fires and the caller's state is
// left untouched, so the user can simply retry instead of staring at a
// silently cleared search box.
export function useOpenDM() {
  const createConv = useCreateConversation();
  const navigate = useNavigate();
  const { mutate } = createConv;
  const openDM = useCallback(
    (userID: string, opts?: { onSuccess?: () => void }) => {
      mutate(
        { type: 'dm', participantIDs: [userID] },
        {
          onSuccess: (conv) => {
            opts?.onSuccess?.();
            navigate(`/conversation/${conv.id}`);
          },
          onError: () => showToast('Could not open the conversation — please try again.'),
        },
      );
    },
    [mutate, navigate],
  );
  return { openDM, isPending: createConv.isPending };
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

// One query per search term, so a slow answer for an older term can never
// replace a newer one; the signal aborts a request nobody is waiting for any
// more. `keepPrevious` shows the last term's results while the next loads
// (a typeahead that blanks between keystrokes flickers).
export function useUserLookup(query: string, options?: { keepPrevious?: boolean }) {
  return useQuery({
    queryKey: queryKeys.searchUsers(query),
    queryFn: async ({ signal }) => {
      const res = await apiFetch<
        { id: string; email: string; displayName: string; avatarURL?: string; userStatus?: UserStatus | null }[]
      >(`/api/v1/users?q=${encodeURIComponent(query)}`, { signal });
      return Array.isArray(res) ? res : [];
    },
    enabled: query.length >= 2,
    placeholderData: options?.keepPrevious ? keepPreviousData : undefined,
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
    queryFn: async () => {
      const res = await apiFetch<User[]>('/api/v1/users?all=true');
      return Array.isArray(res) ? res : [];
    },
    staleTime: 5 * 60 * 1000,
  });
}
