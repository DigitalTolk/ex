import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Message, PaginatedResponse } from '@/types';

function messagePath(opts: { channelId?: string; conversationId?: string; messageId: string }): string {
  if (opts.channelId) return `/api/v1/channels/${opts.channelId}/messages/${opts.messageId}`;
  if (opts.conversationId) return `/api/v1/conversations/${opts.conversationId}/messages/${opts.messageId}`;
  throw new Error('messagePath: channelId or conversationId is required');
}

export function useChannelMessages(channelId: string | undefined) {
  return useInfiniteQuery({
    queryKey: ['channelMessages', channelId],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set('cursor', pageParam);
      params.set('limit', '50');
      return apiFetch<PaginatedResponse<Message>>(
        `/api/v1/channels/${channelId}/messages?${params}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.nextCursor : undefined,
    enabled: !!channelId,
    select: (data) => ({
      pages: [...data.pages].reverse(),
      pageParams: [...data.pageParams].reverse(),
    }),
  });
}

export function useConversationMessages(conversationId: string | undefined) {
  return useInfiniteQuery({
    queryKey: ['conversationMessages', conversationId],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set('cursor', pageParam);
      params.set('limit', '50');
      return apiFetch<PaginatedResponse<Message>>(
        `/api/v1/conversations/${conversationId}/messages?${params}`,
      );
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.nextCursor : undefined,
    enabled: !!conversationId,
    select: (data) => ({
      pages: [...data.pages].reverse(),
      pageParams: [...data.pageParams].reverse(),
    }),
  });
}

export interface SendMessageInput {
  body: string;
  attachmentIDs?: string[];
  parentMessageID?: string; // set when replying inside a thread
}

interface SendMessageScope {
  channelId?: string;
  conversationId?: string;
}

// useSendMessage is the single hook for posting a new message — to a channel,
// a conversation, or as a thread reply (set parentMessageID on the input).
// Pass exactly one of {channelId, conversationId}.
export function useSendMessage(scope: SendMessageScope) {
  const queryClient = useQueryClient();
  const { channelId, conversationId } = scope;
  const path = channelId
    ? `/api/v1/channels/${channelId}/messages`
    : `/api/v1/conversations/${conversationId}/messages`;
  const listKey = channelId
    ? ['channelMessages', channelId]
    : ['conversationMessages', conversationId];

  return useMutation({
    mutationFn: (input: SendMessageInput) =>
      apiFetch<Message>(path, {
        method: 'POST',
        body: JSON.stringify({
          body: input.body,
          parentMessageID: input.parentMessageID ?? '',
          attachmentIDs: input.attachmentIDs ?? [],
        }),
      }),
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: listKey });
      if (input.parentMessageID) {
        const parentPath = channelId ? `channels/${channelId}` : `conversations/${conversationId}`;
        queryClient.invalidateQueries({ queryKey: ['thread', parentPath, input.parentMessageID] });
        // Bump the cross-parent threads list too so the /threads page
        // and the sidebar's thread-unread dot reflect the new reply
        // count immediately, without waiting on the WS round-trip.
        queryClient.invalidateQueries({ queryKey: ['userThreads'] });
      }
    },
  });
}

// Legacy aliases — kept so existing callers and tests don't churn. Prefer
// useSendMessage in new code.
export function useSendChannelMessage(channelId: string | undefined) {
  return useSendMessage({ channelId });
}

export function useSendConversationMessage(conversationId: string | undefined) {
  return useSendMessage({ conversationId });
}

interface MessageMutationVars {
  messageId: string;
  channelId?: string;
  conversationId?: string;
}

function invalidateMessages(qc: ReturnType<typeof useQueryClient>, vars: MessageMutationVars) {
  if (vars.channelId) {
    qc.invalidateQueries({ queryKey: ['channelMessages', vars.channelId] });
    qc.invalidateQueries({ queryKey: ['pinned', `channels/${vars.channelId}`] });
  }
  if (vars.conversationId) {
    qc.invalidateQueries({ queryKey: ['conversationMessages', vars.conversationId] });
    qc.invalidateQueries({ queryKey: ['pinned', `conversations/${vars.conversationId}`] });
  }
}

export function useEditMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: MessageMutationVars & { body: string; attachmentIDs?: string[] }) => {
      const payload: { body: string; attachmentIDs?: string[] } = { body: vars.body };
      if (vars.attachmentIDs !== undefined) payload.attachmentIDs = vars.attachmentIDs;
      return apiFetch<Message>(messagePath(vars), {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (_data, vars) => invalidateMessages(queryClient, vars),
  });
}

export function useDeleteMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: MessageMutationVars) =>
      apiFetch<void>(messagePath(vars), { method: 'DELETE' }),
    onSuccess: (_data, vars) => invalidateMessages(queryClient, vars),
  });
}

export function useToggleReaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: MessageMutationVars & { emoji: string }) =>
      apiFetch<Message>(`${messagePath(vars)}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: vars.emoji }),
      }),
    onSuccess: (_data, vars) => invalidateMessages(queryClient, vars),
  });
}

export function useSetPinned() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: MessageMutationVars & { pinned: boolean }) =>
      apiFetch<Message>(`${messagePath(vars)}/pinned`, {
        method: 'PUT',
        body: JSON.stringify({ pinned: vars.pinned }),
      }),
    onSuccess: (_data, vars) => invalidateMessages(queryClient, vars),
  });
}
