import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { slugify } from '@/lib/format';
import { readJSON, writeJSON } from '@/lib/storage';
import { queryKeys, parentPath } from '@/lib/query-keys';
import { wsLiveQueryOptions } from '@/lib/query-client';
import { markLocalUserStateWrite } from '@/hooks/useUserState';
import { queryClient } from '@/lib/query-client';
import { setUnreadAnchor, threadReadKey } from '@/lib/read-position';
import type { Message, ThreadReadState, UserState } from '@/types';

export interface ThreadSummary {
  parentID: string;
  parentType: 'channel' | 'conversation';
  threadRootID: string;
  rootAuthorID: string;
  rootBody: string;
  rootCreatedAt: string;
  replyCount: number;
  latestActivityAt: string;
  // False: listed because an alert pulled it in (a keyword, an @here), not
  // followed.
  following?: boolean;
  // Listed among the unread threads (they come first).
  unread?: boolean;
}

export interface ThreadPage {
  threads: ThreadSummary[];
  nextCursor?: string;
}

interface ThreadFollowTarget {
  parentID: string;
  parentType: 'channel' | 'conversation';
  threadRootID: string;
}

// useThreadPages loads the Threads page a page at a time: the unread threads
// first, then the rest, latest reply first. Each visit (`visit`, the router's
// location key) is its own list, fetched fresh from the first page; nothing
// refetches it while it shows, so its order never changes under the reader.
export function useThreadPages(visit: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.threadPages(visit),
    queryFn: async ({ pageParam }): Promise<ThreadPage> => {
      const query = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      const res = await apiFetch<ThreadPage>(`/api/v1/threads${query}`);
      return { threads: Array.isArray(res?.threads) ? res.threads : [], nextCursor: res?.nextCursor || undefined };
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}

// updateListedThreads rewrites the listed rows of a thread on every loaded
// Threads page, in place: a thread is never added or moved.
function updateListedThreads(
  qc: QueryClient,
  threadRootID: string,
  update: (row: ThreadSummary) => ThreadSummary | null,
): void {
  qc.setQueriesData<InfiniteData<ThreadPage>>({ queryKey: queryKeys.threadPagesAll() }, (data) => {
    if (!data?.pages.some((p) => p.threads.some((t) => t.threadRootID === threadRootID))) return data;
    return {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        threads: p.threads.flatMap((t) => {
          if (t.threadRootID !== threadRootID) return [t];
          const next = update(t);
          return next ? [next] : [];
        }),
      })),
    };
  });
}

// patchListedThreadFromRoot updates a listed thread from its root's
// `message.edited` payload (published alongside every reply): its reply count,
// latest reply and text.
export function patchListedThreadFromRoot(qc: QueryClient, root: Message): void {
  if (root.parentMessageID) return;
  updateListedThreads(qc, root.id, (row) => ({
    ...row,
    rootAuthorID: root.authorID,
    rootBody: root.body,
    rootCreatedAt: root.createdAt,
    replyCount: root.replyCount ?? row.replyCount,
    latestActivityAt: root.lastReplyAt ?? row.latestActivityAt,
  }));
}

// patchListedThread updates a listed thread from a `thread.updated` event.
export function patchListedThread(qc: QueryClient, summary: ThreadSummary): void {
  updateListedThreads(qc, summary.threadRootID, (row) => ({ ...summary, unread: row.unread }));
}

function threadFollowPath(target: ThreadFollowTarget): string {
  const parentType = target.parentType === 'channel' ? 'channels' : 'conversations';
  return `/api/v1/threads/${parentType}/${encodeURIComponent(target.parentID)}/${encodeURIComponent(target.threadRootID)}/follow`;
}

// useThreadFollowing asks whether the user follows one thread — the thread
// panel's Follow button, fetched when the panel opens.
export function useThreadFollowing(target: ThreadFollowTarget, enabled = true) {
  return useQuery({
    queryKey: queryKeys.threadFollow(target.parentID, target.threadRootID),
    queryFn: async () => (await apiFetch<{ following?: boolean }>(threadFollowPath(target)))?.following === true,
    enabled: enabled && !!target.parentID && !!target.threadRootID,
    staleTime: Infinity,
  });
}

// After a follow change: the thread's Follow button, and its card on the
// Threads page — an unfollowed thread leaves the list at once.
function followChanged(qc: QueryClient, target: ThreadFollowTarget, following: boolean): void {
  qc.setQueryData(queryKeys.threadFollow(target.parentID, target.threadRootID), following);
  updateListedThreads(qc, target.threadRootID, (row) => (following ? { ...row, following } : null));
}

export function useFollowThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: ThreadFollowTarget) =>
      apiFetch<void>(threadFollowPath(target), { method: 'PUT' }),
    onSuccess: (_, target) => followChanged(qc, target, true),
  });
}

export function useUnfollowThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: ThreadFollowTarget) =>
      apiFetch<void>(threadFollowPath(target), { method: 'DELETE' }),
    onSuccess: (_, target) => followChanged(qc, target, false),
  });
}

const SEEN_KEY = 'ex.threads.seen.v1';
export const THREAD_SEEN_CHANGED_EVENT = 'ex:threads-seen-changed';

// Cached parse of the seen-map. Every thread view reads it (threadSeenAt) —
// without the cache that's a JSON.parse per read of a map that grows with
// every viewed thread. Invalidated whenever saveSeen runs.
let seenCache: Record<string, string> | null = null;

function loadSeen(): Record<string, string> {
  if (seenCache) return seenCache;
  seenCache = readJSON<Record<string, string>>(SEEN_KEY, {});
  return seenCache;
}

function saveSeen(map: Record<string, string>) {
  seenCache = map;
  writeJSON(SEEN_KEY, map);
}

export function resetSeenCache() {
  seenCache = null;
}

// Bound the seen-map so it can't grow without limit in localStorage as the user
// views more threads over time. When over the cap, keep the most-recently-seen
// entries (highest ISO timestamp) and drop the oldest.
const SEEN_MAX = 500;
function capSeenMap(map: Record<string, string>): Record<string, string> {
  const keys = Object.keys(map);
  if (keys.length <= SEEN_MAX) return map;
  const kept = keys.sort((a, b) => (map[a] < map[b] ? 1 : -1)).slice(0, SEEN_MAX);
  const next: Record<string, string> = {};
  for (const k of kept) next[k] = map[k];
  return next;
}

// markThreadSeen records an optimistic local timestamp for immediate UI updates.
// The persisted server state deliberately uses server time; the client never
// sends its local clock as authoritative read state.
export function markThreadSeen(
  threadRootID: string,
  at: string = new Date().toISOString(),
  target?: { parentID: string; parentType: 'channel' | 'conversation' },
) {
  const map = { ...loadSeen() };
  map[threadRootID] = at;
  saveSeen(capSeenMap(map));
  // Seeing the thread reads it, and ends a "Mark as unread": the server drops
  // both with the PUT below (or with the reply the user just posted), so drop
  // them from the cached state too — the unread marker is what the Threads
  // dot and the bold Threads cards show.
  queryClient.setQueryData<UserState>(queryKeys.userState(), (prev) =>
    prev?.threadNotifications.includes(threadRootID)
      ? { ...prev, threadNotifications: prev.threadNotifications.filter((id) => id !== threadRootID) }
      : prev,
  );
  queryClient.setQueryData<ThreadReadState>(queryKeys.threadRead(threadRootID), (prev) =>
    prev?.markedUnreadAt ? { seenAt: prev.seenAt } : prev,
  );
  if (target) {
    // The PUT's userchannel.updated {userState:true} echo must not refetch
    // /user-state in this tab (see useUserState's echo window).
    markLocalUserStateWrite();
    const parentType = target.parentType === 'channel' ? 'channels' : 'conversations';
    void apiFetch<void>(
      `/api/v1/user-state/threads/${parentType}/${encodeURIComponent(target.parentID)}/${encodeURIComponent(threadRootID)}/seen`,
      { method: 'PUT' },
    ).catch(() => undefined);
  }
  /* istanbul ignore else -- SSR guard: window is always defined in the browser test env */
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THREAD_SEEN_CHANGED_EVENT, { detail: { threadRootID } }));
  }
}

// useThreadSeenAtOpen is how far the user had read a thread when it opened:
// the server's read time, asked now — never every thread's at once (one row
// per thread ever opened) — merged with this device's seen time from before
// anything marked the thread seen. `known` once the server answered, or
// failed to (this device's time then stands alone); until then nothing may
// mark the thread seen, or the answer would already hold the new time.
// Nothing keeps the answer between visits, so a thread read on another
// device meanwhile opens without a stale line; while open, the user-state
// change event refetches it. No retry: the open waits on it.
export function useThreadSeenAtOpen(threadRootID: string): { known: boolean; seenAt: string | undefined } {
  const readState = useQuery({
    queryKey: queryKeys.threadRead(threadRootID),
    queryFn: async () =>
      (await apiFetch<ThreadReadState>(`/api/v1/user-state/threads/${encodeURIComponent(threadRootID)}`)) ?? {},
    ...wsLiveQueryOptions,
    gcTime: 0,
    retry: false,
  });
  const localAtOpen = useMemo(() => loadSeen()[threadRootID], [threadRootID]);
  return { known: !readState.isPending, seenAt: threadSeenAt(readState.data, localAtOpen) };
}

// seenTime parses a seen timestamp, treating unparseable values as 0 so a
// corrupt entry never outranks a real one.
function seenTime(at: string | undefined): number {
  if (!at) return 0;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : 0;
}

// threadSeenAt is how far the user has read a thread: the newer of the
// server's seen time and this device's (`local`). Keeping the newer matters —
// a stale local time must not shadow a newer read on another device (SPEC
// GAP-2 / I-4). The one exception is a thread marked unread: the server's
// time was rewound on purpose, so a local time from before the mark must not
// outvote it — only seeing the thread again after the mark does.
export function threadSeenAt(server: ThreadReadState = {}, local?: string): string | undefined {
  const { seenAt, markedUnreadAt } = server;
  if (!local) return seenAt;
  if (markedUnreadAt && seenTime(local) <= seenTime(markedUnreadAt)) return seenAt;
  return seenTime(local) >= seenTime(seenAt) ? local : seenAt;
}

// currentThreadSeenAt: how far the user has read a thread right now — the
// open thread's read state (useThreadSeenAtOpen) and this device's seen time.
function currentThreadSeenAt(qc: QueryClient, threadRootID: string): string | undefined {
  return threadSeenAt(qc.getQueryData<ThreadReadState>(queryKeys.threadRead(threadRootID)), loadSeen()[threadRootID]);
}

// noteThreadReadPosition records where a thread's "New messages" line goes —
// the first reply after `seenAt`, how far the user had read — just before
// something marks the thread seen on open. The first note of a visit wins;
// with no reply after that point there's no line. `replace` moves a line
// already drawn: a reply that arrived in the open thread unseen.
export function noteThreadReadPosition(threadRootID: string, seenAt: string | undefined, opts: { replace?: boolean } = {}): void {
  if (seenAt) setUnreadAnchor(threadReadKey(threadRootID), { kind: 'after', at: seenAt }, opts);
}

// noteUnseenThreadReply moves an open thread's line above a reply that
// arrived while the user wasn't following along.
export function noteUnseenThreadReply(qc: QueryClient, threadRootID: string): void {
  noteThreadReadPosition(threadRootID, currentThreadSeenAt(qc, threadRootID), { replace: true });
}

// threadHasUnseen: a reply at `latestAt` is newer than how far the user has
// seen the thread, here or on another device.
export function threadHasUnseen(qc: QueryClient, threadRootID: string, latestAt: string): boolean {
  return seenTime(currentThreadSeenAt(qc, threadRootID)) < seenTime(latestAt);
}

export function getSeenMap(): Record<string, string> {
  return loadSeen();
}

// useThreadMessages fetches all messages in a thread (root + replies).
// Shared by ThreadPanel (the side drawer in a chat view) and ThreadCard
// (the standalone snippet on the /threads page). Both subscribe to the
// same thread query key so a reply posted from either place invalidates
// both views without an extra refetch.
//
// The optional `enabled` flag lets callers gate fetching on something
// other than the parent IDs — e.g. ThreadCard waits for the card to
// enter the viewport to avoid fanning out N parallel requests on
// /threads load.
export function useThreadMessages(opts: {
  channelId?: string;
  conversationId?: string;
  threadRootID: string;
  enabled?: boolean;
}) {
  const path = parentPath(opts);
  const ready = !!(opts.channelId || opts.conversationId) && !!opts.threadRootID;
  return useQuery({
    queryKey: queryKeys.thread(path, opts.threadRootID),
    queryFn: async () => {
      const res = await apiFetch<Message[]>(`/api/v1/${path}/messages/${opts.threadRootID}/thread`);
      return Array.isArray(res) ? res : [];
    },
    enabled: ready && (opts.enabled ?? true),
    // Replies, edits and reactions are patched in from message.* events.
    ...wsLiveQueryOptions,
  });
}

// threadDeepLink builds the URL a thread title points to. The query
// `?thread=<id>` is consumed by Channel/ConversationView to open the
// side panel; the `#msg-<id>` fragment is read by useDeepLinkAnchor
// and passed to MessageList as anchorMsgId, which scrolls the root
// into view and flashes the highlight ring. Both effects need to
// fire for the click to feel like a proper "jump to thread" action.
export function threadDeepLink(
  summary: ThreadSummary,
  channelName: string,
): string {
  const base =
    summary.parentType === 'channel'
      ? `/channel/${slugify(channelName) || summary.parentID}`
      : `/conversation/${summary.parentID}`;
  return `${base}?thread=${summary.threadRootID}#msg-${summary.threadRootID}`;
}
