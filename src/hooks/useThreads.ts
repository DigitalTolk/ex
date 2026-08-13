import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { slugify } from '@/lib/format';
import { readJSON, writeJSON } from '@/lib/storage';
import { queryKeys, parentPath } from '@/lib/query-keys';
import { markLocalUserStateWrite } from '@/hooks/useUserState';
import type { Message } from '@/types';

export interface ThreadSummary {
  parentID: string;
  parentType: 'channel' | 'conversation';
  threadRootID: string;
  rootAuthorID: string;
  rootBody: string;
  rootCreatedAt: string;
  replyCount: number;
  latestActivityAt: string;
}

interface ThreadFollowTarget {
  parentID: string;
  parentType: 'channel' | 'conversation';
  threadRootID: string;
}

export function useUserThreads(options?: { enabled?: boolean }) {
  return useQuery<ThreadSummary[]>({
    queryKey: queryKeys.userThreads(),
    queryFn: async () => {
      const res = await apiFetch<ThreadSummary[]>('/api/v1/threads');
      return Array.isArray(res) ? res : [];
    },
    enabled: options?.enabled ?? true,
    staleTime: 15_000,
  });
}

// userThreadInCache reports whether a thread root is already present in the
// /threads list cache — used to gate the refetch fallback so a race-prone
// re-read can't clobber a freshly-patched row.
export function userThreadInCache(qc: QueryClient, threadRootID: string): boolean {
  return (qc.getQueryData<ThreadSummary[]>(queryKeys.userThreads()) ?? []).some(
    (t) => t.threadRootID === threadRootID,
  );
}

// upsertUserThreadFromRoot patches the /threads list directly from a thread
// root's `message.edited` payload (published alongside every reply), so a
// new/updated thread appears live without the race-prone ListUserThreads refetch
// that read stale (eventually-consistent) DynamoDB state. Only threads the viewer
// provably participates in are ADDED: their own message's thread
// (rootAuthorID === currentUserId) or one already in the list. Others are left to
// the refetch fallback so /threads is never polluted with channel threads the
// viewer isn't in. No-op for non-roots or roots with no replies.
export function upsertUserThreadFromRoot(
  qc: QueryClient,
  root: Message,
  currentUserId: string | undefined,
): void {
  const replyCount = root.replyCount ?? 0;
  if (root.parentMessageID || replyCount < 1) return;
  qc.setQueryData<ThreadSummary[]>(queryKeys.userThreads(), (old) => {
    const list = old ?? [];
    const idx = list.findIndex((t) => t.threadRootID === root.id);
    const mine = !!currentUserId && root.authorID === currentUserId;
    // Can't confirm participation for a thread we don't already track and didn't
    // author — leave it to the refetch fallback rather than guess.
    if (idx < 0 && !mine) return old;
    const summary: ThreadSummary = {
      parentID: root.parentID,
      parentType: root.parentType === 'conversation' ? 'conversation' : 'channel',
      threadRootID: root.id,
      rootAuthorID: root.authorID,
      rootBody: root.body,
      rootCreatedAt: root.createdAt,
      replyCount,
      latestActivityAt: root.lastReplyAt ?? root.createdAt,
    };
    const next = idx >= 0 ? [...list.slice(0, idx), summary, ...list.slice(idx + 1)] : [summary, ...list];
    // Newest activity first, matching the server ordering.
    return next.sort((a, b) => b.latestActivityAt.localeCompare(a.latestActivityAt));
  });
}

// upsertUserThreadRow patches the /threads list from a `thread.updated` event.
// Unlike upsertUserThreadFromRoot (fed by the channel-topic message.edited, which
// reaches non-participants, so it must guess at participation) this is driven by
// a participant-scoped event: the server only sends thread.updated to users who
// belong in the thread, so receipt IS the participation proof and we add the row
// unconditionally. This is what closes the gap where a reply to a thread you
// didn't author used to wait on an eventually-consistent ListUserThreads refetch.
export function upsertUserThreadRow(qc: QueryClient, summary: ThreadSummary): void {
  if (!summary.threadRootID) return;
  qc.setQueryData<ThreadSummary[]>(queryKeys.userThreads(), (old) => {
    const list = old ?? [];
    const idx = list.findIndex((t) => t.threadRootID === summary.threadRootID);
    const next = idx >= 0 ? [...list.slice(0, idx), summary, ...list.slice(idx + 1)] : [summary, ...list];
    return next.sort((a, b) => b.latestActivityAt.localeCompare(a.latestActivityAt));
  });
}

function threadFollowPath(target: ThreadFollowTarget): string {
  const parentType = target.parentType === 'channel' ? 'channels' : 'conversations';
  return `/api/v1/threads/${parentType}/${encodeURIComponent(target.parentID)}/${encodeURIComponent(target.threadRootID)}/follow`;
}

export function useFollowThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: ThreadFollowTarget) =>
      apiFetch<void>(threadFollowPath(target), { method: 'PUT' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userThreads() }),
  });
}

export function useUnfollowThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: ThreadFollowTarget) =>
      apiFetch<void>(threadFollowPath(target), { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.userThreads() }),
  });
}

const SEEN_KEY = 'ex.threads.seen.v1';
export const THREAD_SEEN_CHANGED_EVENT = 'ex:threads-seen-changed';

// Cached parse of the seen-map. /threads can mount 50+ ThreadCards in
// one render, each calling hasUnreadActivity → loadSeen — without the
// cache that's 50 JSON.parse calls on a map that grows unbounded with
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

// seenTime parses a seen-map timestamp, treating unparseable values as 0 so a
// corrupt entry never outranks a real one.
function seenTime(at: string | undefined): number {
  if (!at) return 0;
  const t = new Date(at).getTime();
  return Number.isFinite(t) ? t : 0;
}

// mergeSeenMaps folds the server threadSeen map with the per-device local
// seen map, keeping the NEWER timestamp per thread. Every consumer must use
// this instead of a spread: `{...server, ...local}` let a stale local entry
// shadow a newer server watermark, so a thread read on another device stayed
// unread here forever (SPEC GAP-2 / I-4).
export function mergeSeenMaps(
  server: Record<string, string> | undefined,
  local: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = { ...(server ?? {}) };
  for (const [threadRootID, at] of Object.entries(local)) {
    if (seenTime(at) >= seenTime(merged[threadRootID])) {
      merged[threadRootID] = at;
    }
  }
  return merged;
}

// hasUnreadActivity returns true when latestActivityAt is newer than the
// recorded seen timestamp (or no seen entry exists yet).
export function hasUnreadActivity(t: ThreadSummary, seen: Record<string, string> = loadSeen()): boolean {
  const seenAt = seen[t.threadRootID];
  if (!seenAt) return true;
  return new Date(t.latestActivityAt).getTime() > new Date(seenAt).getTime();
}

export function unreadThreadIDs(
  threads: ThreadSummary[] = [],
  threadNotifications: string[] = [],
  liveThreadNotifications: Set<string> = new Set(),
  seenMap: Record<string, string> = {},
): Set<string> {
  const listedThreadIDs = new Set(threads.map((thread) => thread.threadRootID));
  const ids = new Set(
    [...threadNotifications, ...liveThreadNotifications].filter((threadRootID) =>
      listedThreadIDs.has(threadRootID),
    ),
  );
  for (const thread of threads) {
    if (!seenMap[thread.threadRootID]) {
      continue;
    }
    if (hasUnreadActivity(thread, seenMap)) {
      ids.add(thread.threadRootID);
    } else {
      ids.delete(thread.threadRootID);
    }
  }
  return ids;
}

function activityTime(thread: ThreadSummary): number {
  const time = new Date(thread.latestActivityAt).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function sortThreadsByUnreadThenActivity(
  threads: ThreadSummary[] = [],
  unreadIDs: Set<string> = new Set(),
): ThreadSummary[] {
  return [...threads].sort((a, b) => {
    const aUnread = unreadIDs.has(a.threadRootID);
    const bUnread = unreadIDs.has(b.threadRootID);
    if (aUnread !== bUnread) return aUnread ? -1 : 1;
    return activityTime(b) - activityTime(a);
  });
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
    staleTime: 15_000,
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
