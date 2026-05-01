import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { slugify } from '@/lib/format';
import { readJSON, writeJSON } from '@/lib/storage';
import { queryKeys, parentPath } from '@/lib/query-keys';
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

export function useUserThreads() {
  return useQuery<ThreadSummary[]>({
    queryKey: queryKeys.userThreads(),
    queryFn: async () => {
      const res = await apiFetch<ThreadSummary[]>('/api/v1/threads');
      return Array.isArray(res) ? res : [];
    },
    staleTime: 15_000,
  });
}

const SEEN_KEY = 'ex.threads.seen.v1';

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

// markThreadSeen records the timestamp at which the user last viewed a thread.
// Subsequent threads-list fetches compare against this to decide which threads
// have new activity since the last visit.
export function markThreadSeen(threadRootID: string, at: string = new Date().toISOString()) {
  const map = loadSeen();
  map[threadRootID] = at;
  saveSeen(map);
}

// hasUnreadActivity returns true when latestActivityAt is newer than the
// recorded seen timestamp (or no seen entry exists yet).
export function hasUnreadActivity(t: ThreadSummary, seen: Record<string, string> = loadSeen()): boolean {
  const seenAt = seen[t.threadRootID];
  if (!seenAt) return true;
  return new Date(t.latestActivityAt).getTime() > new Date(seenAt).getTime();
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
