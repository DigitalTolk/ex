import type { ThreadSummary } from '@/hooks/useThreads';

// isFollowedThread: a thread in the /threads list the viewer follows. A row
// can be listed without being followed when an alert (a keyword, an @here)
// pulled it in.
export function isFollowedThread(row: Pick<ThreadSummary, 'following'> | undefined): boolean {
  return !!row && row.following !== false;
}
