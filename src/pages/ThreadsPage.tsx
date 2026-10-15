import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PageContainer } from '@/components/layout/PageContainer';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getSeenMap,
  mergeSeenMaps,
  sortThreadsByUnreadThenActivity,
  THREAD_SEEN_CHANGED_EVENT,
  threadDeepLink,
  unreadThreadIDs,
  useUserThreads,
  type ThreadSummary,
} from '@/hooks/useThreads';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useAuth } from '@/context/AuthContext';
import { useUnread } from '@/context/UnreadContext';
import { useUserState } from '@/hooks/useUserState';
import { ThreadCard } from '@/components/threads/ThreadCard';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

function threadKey(t: ThreadSummary): string {
  return `${t.parentID}#${t.threadRootID}`;
}

// How many thread cards to mount per page as the user scrolls.
const THREADS_PAGE_SIZE = 12;

export default function ThreadsPage() {
  useDocumentTitle('Threads');
  const { data: threads = [], isLoading } = useUserThreads();
  const { data: userChannels } = useUserChannels();
  const { data: userConvs } = useUserConversations();
  const { data: userState } = useUserState();
  const { unreadThreadNotifications } = useUnread();
  const { user } = useAuth();
  const [localSeenMap, setLocalSeenMap] = useState(() => getSeenMap());

  useEffect(() => {
    const handleSeenChange = () => setLocalSeenMap(getSeenMap());
    window.addEventListener(THREAD_SEEN_CHANGED_EVENT, handleSeenChange);
    return () => window.removeEventListener(THREAD_SEEN_CHANGED_EVENT, handleSeenChange);
  }, []);

  const threadUnreadIDs = useMemo(
    () =>
      unreadThreadIDs(
        threads,
        userState?.threadNotifications ?? [],
        unreadThreadNotifications,
        mergeSeenMaps(userState?.threadSeen, localSeenMap, userState?.threadMarkedUnread),
      ),
    [localSeenMap, threads, unreadThreadNotifications, userState],
  );
  const sortedThreads = useMemo(
    () => sortThreadsByUnreadThenActivity(threads, threadUnreadIDs),
    [threadUnreadIDs, threads],
  );

  // The order and membership of the list are frozen per visit. A reply that
  // lands while you read must not reorder the page under you, and a thread
  // that becomes yours waits its turn; the bell and the bold Threads entry
  // still say something arrived. Opening Threads again, the sidebar link
  // included, takes a fresh snapshot: each navigation gets a new location
  // key. The cards themselves stay live.
  const { key: visitKey } = useLocation();
  const [snapshot, setSnapshot] = useState<{ visitKey: string; keys: string[] } | null>(null);
  if (!isLoading && snapshot?.visitKey !== visitKey) {
    setSnapshot({ visitKey, keys: sortedThreads.map(threadKey) });
  }
  const byKey = useMemo(() => new Map(threads.map((t) => [threadKey(t), t])), [threads]);
  const listedThreads = useMemo(
    () => (snapshot ? snapshot.keys.map((k) => byKey.get(k)).filter((t): t is ThreadSummary => !!t) : sortedThreads),
    [snapshot, byKey, sortedThreads],
  );

  // Render threads in pages and grow the window as the user scrolls to the
  // bottom. Each card is a heavy snippet (a message thread + a composer), so
  // mounting all of them at once is what made /threads slow and janky.
  const supportsIO = typeof IntersectionObserver !== 'undefined';
  const [visibleCount, setVisibleCount] = useState(THREADS_PAGE_SIZE);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const visibleThreads = supportsIO ? listedThreads.slice(0, visibleCount) : listedThreads;
  const hasMore = supportsIO && visibleCount < listedThreads.length;

  useEffect(() => {
    if (!hasMore) return;
    const node = loadMoreRef.current;
    // Defensive: hasMore implies threads data arrived, which implies
    // isLoading is false (React Query has no data while pending), so the
    // sentinel div is always mounted — and refs attach before effects run.
    /* istanbul ignore next -- see v8 note */
    /* v8 ignore next -- unreachable defensive guard, see comment above */
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((count) => count + THREADS_PAGE_SIZE);
        }
      },
      { rootMargin: '800px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
    // Re-observe after each growth so a tall viewport keeps filling.
  }, [hasMore, visibleCount]);

  const channelName = (id: string) =>
    userChannels?.find((c) => c.channelID === id)?.channelName ?? '';
  const conversationName = (id: string) =>
    userConvs?.find((c) => c.conversationID === id)?.displayName ?? 'Conversation';

  return (
    // On a phone the threads run edge to edge, one after another: no cards
    // around them taking width from the messages.
    <PageContainer title="Threads" flush>
      {isLoading && (
        <div className="space-y-3 mobile:px-4" data-testid="threads-loading">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 w-full" />
          ))}
        </div>
      )}

      {!isLoading && listedThreads.length === 0 && (
        <p
          className="py-12 text-center text-muted-foreground"
          data-testid="threads-empty"
        >
          No threads
        </p>
      )}

      <div className="space-y-4 mobile:space-y-0">
        {!isLoading &&
          visibleThreads.map((t) => {
            const where =
              t.parentType === 'channel'
                ? `~${channelName(t.parentID) || 'channel'}`
                : conversationName(t.parentID);
            return (
              <ThreadCard
                key={threadKey(t)}
                summary={t}
                title={where}
                deepLink={threadDeepLink(t, channelName(t.parentID))}
                currentUserId={user?.id}
                unread={threadUnreadIDs.has(t.threadRootID)}
              />
            );
          })}
      </div>
      {!isLoading && hasMore && (
        <div ref={loadMoreRef} data-testid="threads-load-more" className="h-1" aria-hidden />
      )}
    </PageContainer>
  );
}
