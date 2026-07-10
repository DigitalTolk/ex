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
import { condemnDraftForSend, removeDraftScopeFromCache } from '@/hooks/useDrafts';
import { markLocalUserStateWrite } from '@/hooks/useUserState';
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
function patchBothScopes(
  qc: QueryClient,
  parentID: string,
  updater: MessageInfiniteUpdater,
  parentType?: Message['parentType'],
) {
  // When the event names its parent scope (server stamps parentType on
  // message events), patch only that scope. Without it, we can't tell
  // whether parentID names a channel or a conversation — setQueriesData
  // is a no-op for non-matching keys, so patch both.
  if (parentType !== 'conversation') {
    qc.setQueriesData<MessageInfiniteData>({ queryKey: queryKeys.channelMessagesAll(parentID) }, updater);
  }
  if (parentType !== 'channel') {
    qc.setQueriesData<MessageInfiniteData>({ queryKey: queryKeys.conversationMessagesAll(parentID) }, updater);
  }
}

// threadScopePaths narrows the thread-query parent paths the same way
// patchBothScopes narrows list scopes: one path when the event names its
// parent type, both when it doesn't.
function threadScopePaths(parentID: string, parentType?: Message['parentType']): string[] {
  if (parentType === 'channel') return [`channels/${parentID}`];
  if (parentType === 'conversation') return [`conversations/${parentID}`];
  return [`channels/${parentID}`, `conversations/${parentID}`];
}

// Same channel-or-conversation ambiguity as patchBothScopes — invalidate
// the thread query under each possible parent path.
export function invalidateThreadBothScopes(
  qc: QueryClient,
  parentID: string,
  threadRootID: string,
  parentType?: Message['parentType'],
) {
  for (const path of threadScopePaths(parentID, parentType)) {
    qc.invalidateQueries({ queryKey: queryKeys.thread(path, threadRootID) });
  }
}

// Patch a single message in the thread query cache in place (both possible
// parent scopes) — the live-update analogue of invalidateThreadBothScopes that
// avoids a refetch. The Threads view (/threads → ThreadCard → useThreadMessages,
// key ['thread', path, rootID]) and the ThreadPanel render reactions / pins /
// edits straight off this cache, so a reaction (or pin/edit/unfurl) toggled on a
// thread message only updates immediately if we patch HERE — patchBothScopes
// only touches the channel/conversation message lists, never ['thread', …].
// No-op when the message isn't currently in the thread cache (the row isn't
// shown), so it's always safe to call.
export function patchMessageInThreadCache(qc: QueryClient, parentID: string, threadRootID: string, msg: Message) {
  const updater = (old: Message[] | undefined) =>
    old ? old.map((m) => (m.id === msg.id ? msg : m)) : old;
  for (const path of threadScopePaths(parentID, msg.parentType)) {
    qc.setQueryData<Message[]>(queryKeys.thread(path, threadRootID), updater);
  }
}

// appendReplyToThreadCache appends a NEW thread reply to the thread message
// cache in place (both possible parent scopes) — the live-update analogue of
// invalidateThreadBothScopes for an incoming reply, so an open ThreadPanel /
// ThreadCard shows it instantly instead of waiting on a refetch (the delay the
// user sees: notification arrives but the thread stays empty until a refresh).
// The thread cache is a flat root-then-replies Message[]; a reply appends to the
// end, matching the optimistic-send path. Returns true when the reply is now
// present in a cached thread (appended, or already there). Returns false when the
// thread isn't cached (panel/card not showing it) — nothing to patch, and the
// next open fetches fresh, so no refetch is needed.
export function appendReplyToThreadCache(
  qc: QueryClient,
  parentID: string,
  threadRootID: string,
  msg: Message,
): boolean {
  let present = false;
  const updater = (old: Message[] | undefined) => {
    // A cached EMPTY thread has no root (reachable when the fetch raced
    // eventual consistency right after the root was created and got 200 +
    // []): appending the reply would render it AS the root. Leave the
    // cache alone and report not-present so the caller's invalidate
    // fallback refetches root + replies together.
    if (!old || old.length === 0) return old;
    present = true;
    if (old.some((m) => m.id === msg.id)) return old;
    return [...old, msg];
  };
  for (const path of threadScopePaths(parentID, msg.parentType)) {
    qc.setQueryData<Message[]>(queryKeys.thread(path, threadRootID), updater);
  }
  return present;
}

// When a message is edited or deleted, any internal-link preview card
// pointing at it (rendered elsewhere) is now stale. Unfurl queries are
// keyed by the raw URL, and a message permalink always embeds `msg-<id>`,
// so invalidate every unfurl query whose URL references this message —
// active cards refetch the fresh (or now-gone) preview.
export function invalidateUnfurlsForMessage(qc: QueryClient, messageID: string) {
  if (!messageID) return;
  qc.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === 'unfurl' &&
      typeof q.queryKey[1] === 'string' &&
      q.queryKey[1].includes(`msg-${messageID}`),
  });
}

// appendMessageToCache prepends a new message to the live-tail page. Returns
// true when the message is now present in pages[0] (appended, or already there)
// — false means the head is a deep-link window mid-history (hasMoreNewer) where
// the message belongs to a not-yet-loaded future page, so the caller may need
// to jump to the tail to surface it.
export function appendMessageToCache(qc: QueryClient, parentID: string, msg: Message): boolean {
  let present = false;
  patchBothScopes(qc, parentID, (old) => {
    if (!old || old.pages.length === 0) return old;
    // Only safely appendable when pages[0] is the live tail. In deep-
    // link mode where the user hasn't paginated forward yet, the WS
    // message belongs to a future page that doesn't exist in cache —
    // leave the chain untouched and let the load-newer sentinel fetch.
    const head = old.pages[0];
    if (head.hasMoreNewer) return old;
    if (head.items.some((m) => m.id === msg.id)) {
      present = true;
      return old;
    }
    const patched: MessageWindow = {
      ...head,
      items: [msg, ...head.items],
      newestID: msg.id,
    };
    present = true;
    return { ...old, pages: [patched, ...old.pages.slice(1)] };
  }, msg.parentType);
  return present;
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
  }, msg.parentType);
}

function deletedMessagePatch(existing: Message, patch?: Partial<Message>): Message {
  return {
    ...existing,
    ...patch,
    id: existing.id,
    parentID: existing.parentID,
    authorID: patch?.authorID ?? existing.authorID,
    createdAt: patch?.createdAt ?? existing.createdAt,
    body: '',
    attachmentIDs: [],
    reactions: undefined,
    deleted: true,
  };
}

export function markMessageDeletedInCache(
  qc: QueryClient,
  parentID: string,
  msgId: string,
  parentMessageID?: string,
  patch?: Partial<Message>,
) {
  patchBothScopes(qc, parentID, (old) => {
    if (!old) return old;
    let changed = false;
    const pages = old.pages.map((p) => {
      if (!p.items.some((m) => m.id === msgId)) return p;
      changed = true;
      return {
        ...p,
        items: p.items.map((m) => (m.id === msgId ? deletedMessagePatch(m, patch) : m)),
      };
    });
    return changed ? { ...old, pages } : old;
  }, patch?.parentType);

  const threadRootID = parentMessageID || msgId;
  for (const path of threadScopePaths(parentID, patch?.parentType)) {
    qc.setQueryData<Message[]>(queryKeys.thread(path, threadRootID), (old) => {
      if (!old || !old.some((m) => m.id === msgId)) return old;
      return old.map((m) => (m.id === msgId ? deletedMessagePatch(m, patch) : m));
    });
  }
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
    // The server folds an UNCONDITIONAL draft-clear for this scope into the
    // send — sending is the authoritative event, no client clock involved.
    // Condemn the scope's draft NOW (at mutate): the current generation is
    // filtered from racing refetches, the session basis resets, in-flight
    // keystroke saves are outdated, and the fold's draft.updated echo is
    // ignored (other tabs still refetch and clear their composer). A THREAD
    // reply additionally triggers the server-side author-seen mark ("posting
    // reads the thread for you"), whose userState echo must not refetch
    // /user-state in this tab either.
    onMutate: (input) => {
      const rollbackDraft = condemnDraftForSend({
        parentID: channelId ?? conversationId,
        parentType: channelId ? 'channel' : 'conversation',
        parentMessageID: input.parentMessageID || undefined,
      });
      if (input.parentMessageID) markLocalUserStateWrite();
      return { rollbackDraft };
    },
    // The send never happened server-side, so neither did its fold — restore
    // the draft protocol state (basis + condemned gen) it had condemned.
    onError: (_error, _input, ctx) => ctx?.rollbackDraft(),
    onSuccess: (data, input) => {
      // The scope's draft is dead (the fold clears it server-side): drop it
      // from the local cache so sidebar/Drafts update without waiting.
      removeDraftScopeFromCache(queryClient, {
        parentID: channelId ?? conversationId,
        parentType: channelId ? 'channel' : 'conversation',
        parentMessageID: input.parentMessageID || undefined,
      });
      const parentID = channelId ?? conversationId;
      // Sender sees their post immediately. Top-level posts append to the
      // main list; thread replies append to the thread cache so the reply
      // shows instantly instead of waiting for the server round-trip (the
      // message.new echo + a userThreads refetch reconcile the rest).
      if (parentID && !input.parentMessageID) {
        const present = appendMessageToCache(queryClient, parentID, data);
        if (!present) {
          // The sender is reading a deep-linked window mid-history, so their
          // message lives in a future page that isn't loaded. Reset the chain
          // to the live tail so they actually see what they just sent instead
          // of the composer silently clearing.
          queryClient.resetQueries({ queryKey: queryKeys.channelMessagesAll(parentID) });
          queryClient.resetQueries({ queryKey: queryKeys.conversationMessagesAll(parentID) });
        }
      }
      if (input.parentMessageID) {
        const path = parentPath({ channelId, conversationId });
        queryClient.setQueryData<Message[]>(
          queryKeys.thread(path, input.parentMessageID),
          (old) => (old ? (old.some((m) => m.id === data.id) ? old : [...old, data]) : old),
        );
        // The /threads list is normally patched live by the participant-scoped
        // `thread.updated` event, built from the authoritative root. That
        // event is gated on the reply-metadata bump succeeding server-side,
        // so a sender whose reply just CREATED their participation (a cached
        // list WITHOUT this thread's row) must not depend on it: refetch once
        // so the new row appears even if the event never fires. When the row
        // is already listed we deliberately skip the refetch — an eventually-
        // consistent ListUserThreads response could clobber the fresher event
        // patch (the race that removed the old blanket invalidate), and on a
        // failed metadata bump the server has no newer count to show anyway.
        // No cached list at all → nothing stale to heal (the first /threads
        // visit fetches fresh).
        const cachedThreads = queryClient.getQueryData<{ threadRootID: string }[]>(
          queryKeys.userThreads(),
        );
        if (cachedThreads && !cachedThreads.some((t) => t.threadRootID === input.parentMessageID)) {
          queryClient.invalidateQueries({ queryKey: queryKeys.userThreads() });
        }
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
  parentMessageID?: string;
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
      /* istanbul ignore else -- messagePath() throws when neither id is set, so a successful mutation always has a parentID; the falsy arm is unreachable. */
      if (parentID) {
        updateMessageInCache(queryClient, parentID, data);
        // Also patch the thread cache so a reaction/pin/edit/unfurl on a thread
        // message updates instantly in /threads and the ThreadPanel. Root ID is
        // the parent message for a reply, else the message itself (a root).
        patchMessageInThreadCache(queryClient, parentID, vars.parentMessageID || vars.messageId, data);
      }
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
      /* istanbul ignore else -- messagePath() throws when neither id is set, so a successful mutation always has a parentID; the falsy arm is unreachable. */
      if (parentID) {
        markMessageDeletedInCache(queryClient, parentID, vars.messageId, vars.parentMessageID);
        const path = parentPath(vars);
        queryClient.invalidateQueries({ queryKey: queryKeys.thread(path, vars.parentMessageID || vars.messageId) });
      }
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
      /* istanbul ignore else -- messagePath() throws when neither id is set, so a successful mutation always has a parentID; the falsy arm is unreachable. */
      if (parentID) {
        updateMessageInCache(queryClient, parentID, data);
        // Also patch the thread cache so a reaction/pin/edit/unfurl on a thread
        // message updates instantly in /threads and the ThreadPanel. Root ID is
        // the parent message for a reply, else the message itself (a root).
        patchMessageInThreadCache(queryClient, parentID, vars.parentMessageID || vars.messageId, data);
      }
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
      /* istanbul ignore else -- messagePath() throws when neither id is set, so a successful mutation always has a parentID; the falsy arm is unreachable. */
      if (parentID) {
        updateMessageInCache(queryClient, parentID, data);
        // Also patch the thread cache so a reaction/pin/edit/unfurl on a thread
        // message updates instantly in /threads and the ThreadPanel. Root ID is
        // the parent message for a reply, else the message itself (a root).
        patchMessageInThreadCache(queryClient, parentID, vars.parentMessageID || vars.messageId, data);
      }
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
      /* istanbul ignore else -- messagePath() throws when neither id is set, so a successful mutation always has a parentID; the falsy arm is unreachable. */
      if (parentID) {
        updateMessageInCache(queryClient, parentID, data);
        // Also patch the thread cache so a reaction/pin/edit/unfurl on a thread
        // message updates instantly in /threads and the ThreadPanel. Root ID is
        // the parent message for a reply, else the message itself (a root).
        patchMessageInThreadCache(queryClient, parentID, vars.parentMessageID || vars.messageId, data);
      }
      invalidatePinnedList(queryClient, vars);
    },
  });
}
