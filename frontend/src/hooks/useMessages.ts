import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys, parentPath } from '@/lib/query-keys';
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
  const queryKey =
    scope === 'channel'
      ? queryKeys.channelMessages(id ?? '', anchorMsgId ?? null)
      : queryKeys.conversationMessages(id ?? '', anchorMsgId ?? null);
  return useInfiniteQuery({
    queryKey,
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
    // WS handlers keep the cache live; auto-refetch would walk forward
    // and truncate deep-link page chains. See appendMessageToCache.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Infinity,
    // Drop deep-link windows on unmount so re-entering the channel
    // without an anchor starts fresh from the live tail.
    gcTime: anchorMsgId ? 0 : undefined,
  });
}

export function useChannelMessages(channelId: string | undefined, anchorMsgId?: string) {
  return useMessagesInfinite({ scope: 'channel', id: channelId, anchorMsgId });
}

export function useConversationMessages(conversationId: string | undefined, anchorMsgId?: string) {
  return useMessagesInfinite({ scope: 'conversation', id: conversationId, anchorMsgId });
}

type MessageInfiniteData = InfiniteData<MessageWindow, MessagePageParam>;
type MessageInfiniteUpdater = (old: MessageInfiniteData | undefined) => MessageInfiniteData | undefined;

// Surgical cache updates for live message events. invalidateQueries on
// these infinite queries triggers v5's walk-forward refetch (see
// infiniteQueryBehavior.js:65) which truncates the page chain after a
// fetchPreviousPage — leaving deep-linked viewers stuck on a 2-message
// slice with no working sentinels.
function patchBothScopes(qc: QueryClient, parentID: string, updater: MessageInfiniteUpdater) {
  // We don't know whether parentID names a channel or a conversation.
  // setQueriesData is a no-op for non-matching keys, so patch both.
  qc.setQueriesData<MessageInfiniteData>({ queryKey: queryKeys.channelMessagesAll(parentID) }, updater);
  qc.setQueriesData<MessageInfiniteData>({ queryKey: queryKeys.conversationMessagesAll(parentID) }, updater);
}

// Same channel-or-conversation ambiguity as patchBothScopes — invalidate
// the thread query under both possible parent paths.
export function invalidateThreadBothScopes(qc: QueryClient, parentID: string, threadRootID: string) {
  qc.invalidateQueries({ queryKey: queryKeys.thread(`channels/${parentID}`, threadRootID) });
  qc.invalidateQueries({ queryKey: queryKeys.thread(`conversations/${parentID}`, threadRootID) });
}

export function appendMessageToCache(qc: QueryClient, parentID: string, msg: Message) {
  patchBothScopes(qc, parentID, (old) => {
    if (!old || old.pages.length === 0) return old;
    // Only safely appendable when pages[0] is the live tail. In deep-
    // link mode where the user hasn't paginated forward yet, the WS
    // message belongs to a future page that doesn't exist in cache —
    // leave the chain untouched and let the load-newer sentinel fetch.
    const head = old.pages[0];
    if (head.hasMoreNewer) return old;
    if (head.items.some((m) => m.id === msg.id)) return old;
    const patched: MessageWindow = {
      ...head,
      items: [msg, ...head.items],
      newestID: msg.id,
    };
    return { ...old, pages: [patched, ...old.pages.slice(1)] };
  });
}

export function updateMessageInCache(qc: QueryClient, parentID: string, msg: Message) {
  patchBothScopes(qc, parentID, (old) => {
    if (!old) return old;
    let changed = false;
    const pages = old.pages.map((p) => {
      if (!p.items.some((m) => m.id === msg.id)) return p;
      changed = true;
      return { ...p, items: p.items.map((m) => (m.id === msg.id ? msg : m)) };
    });
    return changed ? { ...old, pages } : old;
  });
}

export function removeMessageFromCache(qc: QueryClient, parentID: string, msgId: string) {
  patchBothScopes(qc, parentID, (old) => {
    if (!old) return old;
    let changed = false;
    const pages = old.pages.map((p) => {
      if (!p.items.some((m) => m.id === msgId)) return p;
      changed = true;
      return { ...p, items: p.items.filter((m) => m.id !== msgId) };
    });
    return changed ? { ...old, pages } : old;
  });
}

// Catches up cached infinite message queries after a WS reconnect.
// Auto-refetch is disabled (it'd walk forward and truncate), so we
// have to fill the gap ourselves. For each tail-mode query (the user
// is reading the live tail), fetch messages newer than the cached
// newestID and prepend them to pages[0]. Skips deep-link-anchored
// queries where pages[0].hasMoreNewer === true — the user isn't
// reading the live tail there, and the load-newer sentinel will fetch
// what's missing the next time it's in viewport.
export async function resyncMessageCache(qc: QueryClient): Promise<void> {
  const fetches: Promise<void>[] = [];
  for (const scope of ['channelMessages', 'conversationMessages'] as const) {
    const apiScope = scope === 'channelMessages' ? 'channels' : 'conversations';
    for (const [key, data] of qc.getQueriesData<MessageInfiniteData>({ queryKey: [scope] })) {
      if (!data || data.pages.length === 0) continue;
      const head = data.pages[0];
      // Only top up tail-mode chains. Deep-link viewers that haven't
      // paginated forward will miss new messages until they scroll —
      // the load-newer sentinel handles them.
      if (head.hasMoreNewer || !head.newestID) continue;
      const parentID = key[1] as string;
      if (!parentID) continue;
      fetches.push(catchUpTail(qc, key, `/api/v1/${apiScope}/${parentID}/messages`, head.newestID));
    }
  }
  await Promise.allSettled(fetches);
}

async function catchUpTail(
  qc: QueryClient,
  key: QueryKey,
  basePath: string,
  newestID: string,
): Promise<void> {
  try {
    const window = await apiFetch<MessageWindow>(`${basePath}?after=${newestID}&limit=50`);
    if (window.items.length === 0) return;
    qc.setQueryData<MessageInfiniteData>(key, (old) => {
      if (!old || old.pages.length === 0) return old;
      const head = old.pages[0];
      const seen = new Set(head.items.map((m) => m.id));
      const fresh = window.items.filter((m) => !seen.has(m.id));
      if (fresh.length === 0) return old;
      const patched: MessageWindow = {
        ...head,
        items: [...fresh, ...head.items],
        newestID: window.newestID ?? fresh[0]?.id ?? head.newestID,
        // Forward window may report there are even more newer beyond
        // the 50 we just fetched; surface that to the sentinel.
        hasMoreNewer: window.hasMoreNewer ?? head.hasMoreNewer,
      };
      return { ...old, pages: [patched, ...old.pages.slice(1)] };
    });
  } catch {
    // Reconnect resync is best-effort; the next user interaction
    // (scroll, navigate) will re-fetch via existing flows.
  }
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
    onSuccess: (data, input) => {
      const parentID = channelId ?? conversationId;
      // Top-level only — sender sees their post immediately. Thread
      // replies are reconciled via the message.edited event the
      // backend publishes alongside message.new.
      if (parentID && !input.parentMessageID) {
        appendMessageToCache(queryClient, parentID, data);
      }
      if (input.parentMessageID) {
        const path = parentPath({ channelId, conversationId });
        queryClient.invalidateQueries({ queryKey: queryKeys.thread(path, input.parentMessageID) });
        queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
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

// Pinned list is non-infinite; invalidation is safe here.
function invalidatePinnedList(qc: ReturnType<typeof useQueryClient>, vars: MessageMutationVars) {
  if (vars.channelId) {
    qc.invalidateQueries({ queryKey: queryKeys.pinned(`channels/${vars.channelId}`) });
  }
  if (vars.conversationId) {
    qc.invalidateQueries({ queryKey: queryKeys.pinned(`conversations/${vars.conversationId}`) });
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
    onSuccess: (data, vars) => {
      const parentID = vars.channelId ?? vars.conversationId;
      if (parentID) updateMessageInCache(queryClient, parentID, data);
      invalidatePinnedList(queryClient, vars);
    },
  });
}

export function useDeleteMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: MessageMutationVars) =>
      apiFetch<void>(messagePath(vars), { method: 'DELETE' }),
    onSuccess: (_data, vars) => {
      const parentID = vars.channelId ?? vars.conversationId;
      if (parentID) removeMessageFromCache(queryClient, parentID, vars.messageId);
      invalidatePinnedList(queryClient, vars);
    },
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
    onSuccess: (data, vars) => {
      const parentID = vars.channelId ?? vars.conversationId;
      if (parentID) updateMessageInCache(queryClient, parentID, data);
      invalidatePinnedList(queryClient, vars);
    },
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
    onSuccess: (data, vars) => {
      const parentID = vars.channelId ?? vars.conversationId;
      if (parentID) updateMessageInCache(queryClient, parentID, data);
      invalidatePinnedList(queryClient, vars);
    },
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
    onSuccess: (data, vars) => {
      const parentID = vars.channelId ?? vars.conversationId;
      if (parentID) updateMessageInCache(queryClient, parentID, data);
      invalidatePinnedList(queryClient, vars);
    },
  });
}
