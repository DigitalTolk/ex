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
import { useCallback } from 'react';
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
    // The WS handlers patch pages surgically and keep message identities;
    // React Query's structural sharing would undo that: a live append shifts
    // every item of the tail page by one index, and the index-wise deep
    // compare then copies all 50 objects — which re-rendered every row on
    // each arrival.
    structuralSharing: false,
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
    return withSent(old, msg, 'end');
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

// ---- Optimistic send --------------------------------------------------------
// A sent message shows at once as a pending row (pendingState 'sending', a
// temporary id) and is swapped for the real one when it lands. The server
// echoes the client nonce (X-Client-Nonce) on both the send response and the
// message.new broadcast, so whichever arrives first replaces the row and the
// other finds it already there — no duplicate, whatever the order.

export const CLIENT_NONCE_HEADER = 'X-Client-Nonce';

export function newClientNonce(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function pendingMessageID(nonce: string): string {
  return `pending-${nonce}`;
}

function maxMessageID(a: string | undefined, b: string): string {
  return a && a > b ? a : b;
}

// withSent places msg in a list (at the newest end: 'start' for the newest-
// first message pages, 'end' for a thread) unless it's already there. The real
// message for an optimistic row replaces that row in place — or drops it when
// the real one already arrived another way. Returns `items` itself when
// nothing changes.
function withSent(items: Message[], msg: Message, at: 'start' | 'end'): Message[] {
  const pendingAt =
    msg.clientNonce && !msg.pendingState
      ? items.findIndex((m) => m.pendingState && m.clientNonce === msg.clientNonce)
      : -1;
  if (items.some((m) => m.id === msg.id)) {
    return pendingAt >= 0 ? items.filter((_, i) => i !== pendingAt) : items;
  }
  if (pendingAt >= 0) return items.map((m, i) => (i === pendingAt ? msg : m));
  return at === 'start' ? [msg, ...items] : [...items, msg];
}

// setPendingState marks a pending row 'sending' / 'failed', or removes it
// (null), wherever it's cached: the live-tail pages or the thread.
export function setPendingState(qc: QueryClient, msg: Message, state: Message['pendingState'] | null) {
  const update = (items: Message[]) =>
    state === null
      ? items.filter((m) => m.id !== msg.id)
      : items.map((m) => (m.id === msg.id ? { ...m, pendingState: state } : m));
  if (msg.parentMessageID) {
    for (const path of threadScopePaths(msg.parentID, msg.parentType)) {
      qc.setQueryData<Message[]>(queryKeys.thread(path, msg.parentMessageID), (old) => (old ? update(old) : old));
    }
    return;
  }
  patchBothScopes(qc, msg.parentID, (old) => {
    if (!old || old.pages.length === 0) return old;
    const [head, ...rest] = old.pages;
    return { ...old, pages: [{ ...head, items: update(head.items) }, ...rest] };
  }, msg.parentType);
}

// placeSentMessage puts a confirmed message into its list or thread,
// replacing its pending row. Returns false when it couldn't be placed (a
// deep-link window or an uncached thread).
export function placeSentMessage(qc: QueryClient, msg: Message): boolean {
  if (msg.parentMessageID) return appendReplyToThreadCache(qc, msg.parentID, msg.parentMessageID, msg);
  return appendMessageToCache(qc, msg.parentID, msg);
}

function sendPath(parentType: Message['parentType'], parentID: string): string {
  return `/api/v1/${parentType === 'conversation' ? 'conversations' : 'channels'}/${encodeURIComponent(parentID)}/messages`;
}

// usePendingMessageActions: the "Not sent" row's Retry (same nonce, so a late
// echo of the first attempt still reconciles) and Delete.
export function usePendingMessageActions() {
  const qc = useQueryClient();
  const retry = useCallback(
    (msg: Message) => {
      setPendingState(qc, msg, 'sending');
      void apiFetch<Message>(sendPath(msg.parentType, msg.parentID), {
        method: 'POST',
        headers: msg.clientNonce ? { [CLIENT_NONCE_HEADER]: msg.clientNonce } : undefined,
        body: JSON.stringify({
          body: msg.body,
          parentMessageID: msg.parentMessageID ?? '',
          attachmentIDs: msg.attachmentIDs ?? [],
        }),
      })
        .then((sent) => {
          placeSentMessage(qc, { ...sent, parentType: msg.parentType, clientNonce: sent.clientNonce ?? msg.clientNonce });
        })
        .catch(() => setPendingState(qc, msg, 'failed'));
    },
    [qc],
  );
  const discard = useCallback((msg: Message) => setPendingState(qc, msg, null), [qc]);
  return { retry, discard };
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
    present = true;
    const items = withSent(head.items, msg, 'start');
    if (items === head.items) return old;
    const patched: MessageWindow = {
      ...head,
      items,
      // A pending row's id is not a server id — never let it become the
      // newer-than cursor reconnect catch-up pages from.
      newestID: msg.pendingState ? head.newestID : maxMessageID(head.newestID, msg.id),
    };
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
  clientNonce?: string; // filled in by useSendMessage's mutate
}

// What actually goes to the server: mutate/mutateAsync always fill the nonce.
type SendMessageVars = SendMessageInput & { clientNonce: string };

interface SendMessageScope {
  channelId?: string;
  conversationId?: string;
  // The sender. When known, a sent message shows at once as a pending row.
  authorID?: string;
}

// useSendMessage is the single hook for posting a new message — to a channel,
// a conversation, or as a thread reply (set parentMessageID on the input).
// Pass exactly one of {channelId, conversationId}.
export function useSendMessage(scope: SendMessageScope) {
  const queryClient = useQueryClient();
  const { channelId, conversationId, authorID } = scope;
  const path = channelId
    ? `/api/v1/channels/${channelId}/messages`
    : `/api/v1/conversations/${conversationId}/messages`;
  const parentID = channelId ?? conversationId;
  const parentType: Message['parentType'] = channelId ? 'channel' : 'conversation';

  const mutation = useMutation({
    mutationFn: (input: SendMessageVars) =>
      apiFetch<Message>(path, {
        method: 'POST',
        headers: { [CLIENT_NONCE_HEADER]: input.clientNonce },
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
      // Show the message right away as pending (see "Optimistic send").
      let pending: Message | undefined;
      if (authorID && parentID) {
        const row: Message = {
          id: pendingMessageID(input.clientNonce),
          clientNonce: input.clientNonce,
          pendingState: 'sending',
          parentID,
          parentType,
          authorID,
          body: input.body,
          attachmentIDs: input.attachmentIDs,
          parentMessageID: input.parentMessageID || undefined,
          createdAt: new Date().toISOString(),
        };
        if (placeSentMessage(queryClient, row)) pending = row;
      }
      return { rollbackDraft, pending };
    },
    // The send never happened server-side, so neither did its fold — restore
    // the draft protocol state (basis + condemned gen) it had condemned. The
    // pending row stays, marked "Not sent", with Retry / Delete.
    onError: (_error, _input, ctx) => {
      ctx?.rollbackDraft();
      if (ctx?.pending) setPendingState(queryClient, ctx.pending, 'failed');
    },
    onSuccess: (response, input) => {
      // The response is this send's message even from a server that doesn't
      // echo the nonce (mid rolling deploy): match it to its pending row.
      const data = { ...response, clientNonce: response.clientNonce ?? input.clientNonce };
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
          (old) => (old ? withSent(old, data, 'end') : old),
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

  // Every send gets a client nonce, so its pending row and the real message
  // can be matched up (and a Retry reuses it).
  const { mutate: rawMutate, mutateAsync: rawMutateAsync } = mutation;
  const mutate = useCallback(
    (input: SendMessageInput, options?: Parameters<typeof rawMutate>[1]) =>
      rawMutate({ ...input, clientNonce: input.clientNonce ?? newClientNonce() }, options),
    [rawMutate],
  );
  const mutateAsync = useCallback(
    (input: SendMessageInput, options?: Parameters<typeof rawMutateAsync>[1]) =>
      rawMutateAsync({ ...input, clientNonce: input.clientNonce ?? newClientNonce() }, options),
    [rawMutateAsync],
  );
  return { ...mutation, mutate, mutateAsync };
}

// Legacy aliases — kept so existing callers and tests don't churn. Prefer
// useSendMessage in new code.
// authorID (the signed-in user) lets a send show at once as a pending row.
export function useSendChannelMessage(channelId: string | undefined, authorID?: string) {
  return useSendMessage({ channelId, authorID });
}

export function useSendConversationMessage(conversationId: string | undefined, authorID?: string) {
  return useSendMessage({ conversationId, authorID });
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
