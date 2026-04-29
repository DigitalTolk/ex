import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { Message } from '@/types';

export interface MessageWindow {
  items: Message[];
  hasMoreOlder: boolean;
  hasMoreNewer: boolean;
  oldestID?: string;
  newestID?: string;
}

// PageParam encodes which direction (and from which cursor) to fetch.
// `kind: 'tail'` is the initial latest-first page; `around` seeds a
// window centred on a deep-link target.
export type MessagePageParam =
  | { kind: 'tail' }
  | { kind: 'older'; cursor: string }
  | { kind: 'newer'; after: string }
  | { kind: 'around'; msgId: string; before: number; after: number };

function messagePath(opts: { channelId?: string; conversationId?: string; messageId: string }): string {
  if (opts.channelId) return `/api/v1/channels/${opts.channelId}/messages/${opts.messageId}`;
  if (opts.conversationId) return `/api/v1/conversations/${opts.conversationId}/messages/${opts.messageId}`;
  throw new Error('messagePath: channelId or conversationId is required');
}

function fetchMessageWindow(basePath: string, p: MessagePageParam): Promise<MessageWindow> {
  const params = new URLSearchParams();
  switch (p.kind) {
    case 'tail':
      params.set('limit', '50');
      break;
    case 'older':
      params.set('cursor', p.cursor);
      params.set('limit', '50');
      break;
    case 'newer':
      params.set('after', p.after);
      params.set('limit', '50');
      break;
    case 'around':
      params.set('around', p.msgId);
      params.set('before', String(p.before));
      params.set('after_count', String(p.after));
      break;
  }
  return apiFetch<MessageWindow>(`${basePath}?${params.toString()}`);
}

// `anchorMsgId` seeds the initial fetch with a centred window instead
// of the latest tail (deep-link path).
function useMessagesInfinite(opts: {
  scope: 'channel' | 'conversation';
  id: string | undefined;
  anchorMsgId?: string;
}) {
  const { scope, id, anchorMsgId } = opts;
  const basePath =
    scope === 'channel'
      ? `/api/v1/channels/${id}/messages`
      : `/api/v1/conversations/${id}/messages`;
  return useInfiniteQuery({
    queryKey: [`${scope}Messages`, id, anchorMsgId ?? null],
    queryFn: ({ pageParam }) => fetchMessageWindow(basePath, pageParam),
    initialPageParam: anchorMsgId
      ? ({ kind: 'around', msgId: anchorMsgId, before: 25, after: 25 } as MessagePageParam)
      : ({ kind: 'tail' } as MessagePageParam),
    getNextPageParam: (lastPage): MessagePageParam | undefined =>
      lastPage.hasMoreOlder && lastPage.oldestID
        ? { kind: 'older', cursor: lastPage.oldestID }
        : undefined,
    getPreviousPageParam: (firstPage): MessagePageParam | undefined =>
      firstPage.hasMoreNewer && firstPage.newestID
        ? { kind: 'newer', after: firstPage.newestID }
        : undefined,
    enabled: !!id,
    // v5's stale-refetch (mount, WS-driven invalidate) walks forward
    // from pages[0] via getNextPageParam. After a fetchPreviousPage,
    // pages[0] is the newer-window — and our after-fetch responses
    // come back with hasMoreOlder=false, so the walk stops at page 0
    // and the older around-window stays cached but never re-runs.
    // Re-mounting the same queryKey then sees that stale shape and
    // fires only `?after=<newestID>`, leaving the user staring at a
    // 2-message slice of a 35-message conversation. Wiping anchored
    // caches on unmount sidesteps the whole walk: each /search → DM
    // hop starts from initialPageParam and cleanly re-fires
    // `?around=…`. Tail-mode queries never hit this shape (no
    // bidirectional pages), so they keep the default 5-minute cache.
    gcTime: anchorMsgId ? 0 : undefined,
  });
}

export function useChannelMessages(channelId: string | undefined, anchorMsgId?: string) {
  return useMessagesInfinite({ scope: 'channel', id: channelId, anchorMsgId });
}

export function useConversationMessages(conversationId: string | undefined, anchorMsgId?: string) {
  return useMessagesInfinite({ scope: 'conversation', id: conversationId, anchorMsgId });
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

// useSetNoUnfurl flips the per-message link-preview suppression flag.
// Author-only on the server side; the UI gates the X button to the
// author too.
export function useSetNoUnfurl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: MessageMutationVars & { noUnfurl: boolean }) =>
      apiFetch<Message>(`${messagePath(vars)}/no-unfurl`, {
        method: 'PUT',
        body: JSON.stringify({ noUnfurl: vars.noUnfurl }),
      }),
    onSuccess: (_data, vars) => invalidateMessages(queryClient, vars),
  });
}
