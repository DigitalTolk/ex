import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Virtuoso } from 'react-virtuoso';
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

// Cards mounted on the first paint, before the list has measured the view.
const INITIAL_CARDS = 6;

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

  // Virtualized over the page's own scroller: each card is a heavy snippet
  // (a whole thread, its query, a composer), and mounting every card paged in
  // so far is what made a long /threads slow. Only the cards near the view
  // are mounted; one scrolled far away unmounts and comes back as it nears
  // again (still marking its thread read once it is in view, see ThreadCard).
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const attachScrollParent = useCallback((node: HTMLDivElement | null) => {
    setScrollParent(node?.closest<HTMLElement>('[data-page-scroll="true"]') ?? null);
  }, []);
  // A card's own state goes with it when it unmounts, so the page keeps
  // which threads were expanded.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const expand = useCallback((key: string) => setExpanded((prev) => new Set(prev).add(key)), []);

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

      <div ref={attachScrollParent}>
        {!isLoading && scrollParent && (
          <Virtuoso
            customScrollParent={scrollParent}
            data={listedThreads}
            computeItemKey={(_, t) => threadKey(t)}
            increaseViewportBy={800}
            initialItemCount={Math.min(listedThreads.length, INITIAL_CARDS)}
            itemContent={(_, t) => {
              const key = threadKey(t);
              const where =
                t.parentType === 'channel'
                  ? `~${channelName(t.parentID) || 'channel'}`
                  : conversationName(t.parentID);
              return (
                // The gap between cards, inside the item so the list measures
                // it; on a phone the threads run on, a rule between them.
                <div className="pb-4 mobile:pb-0">
                  <ThreadCard
                    summary={t}
                    title={where}
                    deepLink={threadDeepLink(t, channelName(t.parentID))}
                    currentUserId={user?.id}
                    unread={threadUnreadIDs.has(t.threadRootID)}
                    expanded={expanded.has(key)}
                    onExpand={() => expand(key)}
                  />
                </div>
              );
            }}
          />
        )}
      </div>
    </PageContainer>
  );
}
