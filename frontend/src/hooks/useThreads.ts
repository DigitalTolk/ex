import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { slugify } from '@/lib/format';
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
    queryKey: ['userThreads'],
    queryFn: () => apiFetch<ThreadSummary[]>('/api/v1/threads'),
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
  if (typeof localStorage === 'undefined') {
    seenCache = {};
    return seenCache;
  }
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    seenCache = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    seenCache = {};
  }
  return seenCache;
}

function saveSeen(map: Record<string, string>) {
  seenCache = map;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
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

// threadParentPath returns the URL prefix for messages in a thread's
// parent — `channels/<id>` or `conversations/<id>`. Used by every site
// that fetches or invalidates thread messages, so the cache key shape
// stays in lockstep across hooks and components.
export function threadParentPath(opts: { channelId?: string; conversationId?: string }): string {
  return opts.channelId ? `channels/${opts.channelId}` : `conversations/${opts.conversationId}`;
}

// useThreadMessages fetches all messages in a thread (root + replies).
// Shared by ThreadPanel (the side drawer in a chat view) and ThreadCard
// (the standalone snippet on the /threads page). Both subscribe to the
// same `['thread', parentPath, rootID]` key so a reply posted from
// either place invalidates both views without an extra refetch.
//
// The optional `enabled` flag lets callers gate fetching on something
// other than the parent IDs — e.g. ThreadCard waits for the card to
// enter the viewport to avoid fanning out N parallel requests on
// /threads load. When omitted, the query runs as soon as the parent
// IDs are present.
export function useThreadMessages(opts: {
  channelId?: string;
  conversationId?: string;
  threadRootID: string;
  enabled?: boolean;
}) {
  const parentPath = threadParentPath(opts);
  const ready = !!(opts.channelId || opts.conversationId) && !!opts.threadRootID;
  return useQuery({
    queryKey: ['thread', parentPath, opts.threadRootID],
    queryFn: () =>
      apiFetch<Message[]>(`/api/v1/${parentPath}/messages/${opts.threadRootID}/thread`),
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
