import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Virtuoso } from 'react-virtuoso';
import { PageContainer } from '@/components/layout/PageContainer';
import { Skeleton } from '@/components/ui/skeleton';
import { threadDeepLink, useThreadPages, type ThreadSummary } from '@/hooks/useThreads';
import { useUnreadThreadIDs } from '@/hooks/useUnreadThreads';
import { useUserChannels } from '@/hooks/useChannels';
import { useUserConversations } from '@/hooks/useConversations';
import { useAuth } from '@/context/AuthContext';
import { ThreadCard } from '@/components/threads/ThreadCard';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';

function threadKey(t: ThreadSummary): string {
  return `${t.parentID}#${t.threadRootID}`;
}

// Cards mounted on the first paint, before the list has measured the view.
const INITIAL_CARDS = 6;

export default function ThreadsPage() {
  useDocumentTitle('Threads');
  const { data: userChannels } = useUserChannels();
  const { data: userConvs } = useUserConversations();
  const threadUnreadIDs = useUnreadThreadIDs();
  const { user } = useAuth();

  // The list comes a page at a time — the unread threads first, then the
  // rest, latest reply first — and more loads as the reader reaches its end.
  // Each visit is its own list: a reply that lands while you read must not
  // reorder the page under you, and a thread that becomes yours waits for the
  // next visit; the bell and the bold Threads entry still say something
  // arrived. Opening Threads again, the sidebar link included, starts over:
  // each navigation gets a new location key. The cards themselves stay live.
  const { key: visitKey } = useLocation();
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } = useThreadPages(visitKey);
  const listedThreads = useMemo(() => {
    // A thread read since its page loaded can come again among the rest.
    const seen = new Set<string>();
    return (data?.pages ?? []).flatMap((page) =>
      page.threads.filter((t) => {
        const key = threadKey(t);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  }, [data]);
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  // A page can come back empty yet point further on (none unread, or only
  // threads it couldn't show): nothing new reaches the end of the list then,
  // so ask for the next one here.
  const lastPageEmpty = data?.pages.at(-1)?.threads.length === 0;
  useEffect(() => {
    if (lastPageEmpty) loadMore();
  }, [lastPageEmpty, loadMore]);

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

      {!isLoading && listedThreads.length === 0 && !hasNextPage && (
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
            // The next page loads once the last card renders: on screen, or
            // within the 800px the list renders ahead. Not endReached: that
            // only fires on a scroll, so a list that already fit the screen
            // (a few unread threads) never went on to the rest.
            itemsRendered={(items) => {
              if (items.at(-1)?.index === listedThreads.length - 1) loadMore();
            }}
            components={{ Footer: isFetchingNextPage ? ThreadsLoadingMore : undefined }}
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

function ThreadsLoadingMore() {
  return (
    <div className="pb-4 mobile:px-4" data-testid="threads-loading-more">
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
