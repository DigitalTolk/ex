import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

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

function loadSeen(): Record<string, string> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveSeen(map: Record<string, string>) {
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
