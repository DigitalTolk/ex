import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageItem } from './MessageItem';
import { useMessageDeepLinkHighlight } from '@/hooks/useMessageDeepLinkHighlight';
import { dayKey, formatDayHeading } from '@/lib/format';
import { deriveThreadMeta } from '@/lib/message-users';
import type { Message } from '@/types';

export interface UserMapEntry {
  displayName: string;
  avatarURL?: string;
  online?: boolean;
}

interface MessageListProps {
  pages: { items: Message[] }[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isLoading: boolean;
  fetchNextPage: () => void;
  // Force-check for older messages. Called when the user wheel-scrolls
  // up past the top of the list — useful when local pagination thinks
  // it's hit the beginning but the server has more (cache staleness).
  refetch?: () => void;
  currentUserId?: string;
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  userMap: Record<string, UserMapEntry>;
  onReplyInThread?: (messageID: string) => void;
  // Rendered at the top of the list once we've paged back to the very first
  // message (hasNextPage is false). Owners pass the variant that matches the
  // parent kind: ChannelIntro / DMIntro / SelfDMIntro / GroupIntro.
  intro?: ReactNode;
}

export function MessageList({
  pages,
  hasNextPage,
  isFetchingNextPage,
  isLoading,
  fetchNextPage,
  refetch,
  currentUserId,
  channelId,
  channelSlug,
  conversationId,
  userMap,
  onReplyInThread,
  intro,
}: MessageListProps) {
  useMessageDeepLinkHighlight([channelId, conversationId, isLoading, pages.length]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Adapter so each ThreadActionBar can read user records from the
  // single userMap we already have, instead of issuing its own
  // /users/batch fetch per thread.
  const userLookup = useMemo(
    () => ({ get: (id: string) => userMap[id] }),
    [userMap],
  );

  const allMessages = useMemo(
    () => pages.flatMap((p) => p.items).reverse(),
    [pages],
  );

  // Backfill thread metadata from sibling replies — covers messages whose
  // stored RecentReplyAuthorIDs / LastReplyAt fields predate that feature.
  const threadMeta = useMemo(() => deriveThreadMeta(allMessages), [allMessages]);

  // Track whether the user is "at the bottom" of the messages so we
  // know whether new arrivals or settling async content should pull
  // them down or stay put. Threshold of 120px gives a little slack so
  // a click that scrolls 1-2 messages up doesn't flip them out of
  // "at bottom" mode.
  const wasAtBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      wasAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    return () => el.removeEventListener('scroll', update);
  }, []);

  // Stick to the bottom on initial load and whenever the user switches
  // channels/conversations. We do not just set scrollTop once: avatars,
  // attachments, and unfurl cards inside the visible viewport finish
  // sizing themselves AFTER our first synchronous scrollTop write, and
  // their growth nudges the user off the bottom (browser scroll
  // anchoring corrects shifts ABOVE the anchor but not below). The
  // ResizeObserver below lives for the entire channel session and
  // re-pins to the bottom whenever the inner content's height
  // changes — gated by wasAtBottomRef so it doesn't yank a user who
  // has intentionally scrolled up to read older content. This single
  // observer also handles "follow live conversation": when a new
  // message lands at the bottom while the reader is still at the
  // bottom, the height change triggers stick() and the view follows.
  const stickyBottomDoneRef = useRef(false);
  const stickyROrRef = useRef<ResizeObserver | null>(null);
  useLayoutEffect(() => {
    // Channel/DM switch: re-arm initial scroll-to-bottom and tear
    // down the previous channel's observer so the next channel sets
    // up its own.
    stickyBottomDoneRef.current = false;
    if (stickyROrRef.current) {
      stickyROrRef.current.disconnect();
      stickyROrRef.current = null;
    }
  }, [channelId, conversationId]);
  useLayoutEffect(() => {
    if (stickyBottomDoneRef.current) return;
    if (allMessages.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const stick = () => {
      el.scrollTop = el.scrollHeight;
      wasAtBottomRef.current = true;
    };
    stick();
    stickyBottomDoneRef.current = true;
    if (typeof ResizeObserver === 'undefined') return;
    const inner = el.lastElementChild;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (wasAtBottomRef.current) stick();
    });
    ro.observe(inner);
    stickyROrRef.current = ro;
  }, [allMessages.length]);
  useEffect(
    () => () => {
      if (stickyROrRef.current) {
        stickyROrRef.current.disconnect();
        stickyROrRef.current = null;
      }
    },
    [],
  );

  // Snap to the bottom when the bottom of the chat changes (a new
  // message landed at the end). The persistent bottom-stick observer
  // above already follows live conversation when the user is at the
  // bottom; this layer covers the remaining case where the user has
  // scrolled up but JUST SENT a message — they expect to see it,
  // even if they were reading older content. After this scroll, the
  // user is at the bottom (wasAtBottomRef=true) so the persistent
  // observer takes over and keeps re-pinning as async content
  // (attachments, unfurl cards) settles.
  //
  // Why "bottom of chat" rather than "newest own anywhere": when an
  // older page prepends and includes the user's older messages, a
  // "newest own anywhere" check flips null→ID and we'd misread it as
  // a fresh send — yanking the user back to the bottom of the channel
  // and forcing them to re-scroll everything they just scrolled past.
  // A real send always lands at the bottom; an older-page prepend
  // never touches it.
  const lastBottomIdRef = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    const bottom = allMessages[allMessages.length - 1];
    const bottomId = bottom?.id ?? null;
    const wasFirstRun = lastBottomIdRef.current === undefined;
    if (bottomId === lastBottomIdRef.current) return;
    lastBottomIdRef.current = bottomId;
    if (wasFirstRun) return;
    if (!bottom || bottom.parentMessageID) return;
    if (bottom.authorID !== currentUserId) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    wasAtBottomRef.current = true;
  }, [allMessages, currentUserId]);

  // Force-check for older messages when the user is at the very top
  // and keeps trying to scroll up. Useful when local pagination thinks
  // it has reached the beginning (hasNextPage=false) but the server
  // actually has more — calling refetch() re-evaluates `hasMore` so
  // the load-more sentinel can come back. Rate-limited so a flicked
  // mousewheel doesn't fire a thundering herd of requests.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !refetch) return;
    let upDelta = 0;
    let lastTrigger = 0;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollTop > 5) {
        upDelta = 0;
        return;
      }
      if (e.deltaY >= 0) {
        upDelta = 0;
        return;
      }
      upDelta += -e.deltaY;
      if (upDelta < 80) return;
      upDelta = 0;
      const now = Date.now();
      if (now - lastTrigger < 3000) return;
      lastTrigger = now;
      refetch();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => el.removeEventListener('wheel', onWheel);
  }, [refetch]);

  useEffect(() => {
    const node = loadMoreRef.current;
    const root = scrollRef.current;
    if (!node || !root || !hasNextPage) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isFetchingNextPage) {
            fetchNextPage();
            return;
          }
        }
      },
      // Generous rootMargin so the next page starts loading well before
      // the user reaches the top.
      { root, rootMargin: '800px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, pages.length]);

  if (isLoading) {
    return (
      <div className="flex-1 p-4 space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-64" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Group by date for separators
  let lastDate = '';
  const elements: ReactNode[] = [];

  // The intro renders at the very top of the message list — but only once
  // we've paged back to the start (no older messages remaining). This
  // mirrors how chat apps reveal "this is the beginning of …" only when
  // the user actually reaches the beginning.
  if (intro && !hasNextPage) {
    elements.push(<div key="intro">{intro}</div>);
  }

  for (const msg of allMessages) {
    // Skip thread replies in the main list (they live in the ThreadPanel)
    if (msg.parentMessageID) continue;

    const msgDate = dayKey(msg.createdAt);
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      elements.push(
        <div
          key={`date-${msgDate}`}
          data-testid="day-divider"
          className="flex items-center gap-3 py-2"
          role="separator"
        >
          <div className="flex-1 border-t border-border" />
          <span className="text-xs font-medium text-muted-foreground">
            {formatDayHeading(msg.createdAt)}
          </span>
          <div className="flex-1 border-t border-border" />
        </div>,
      );
    }

    if (msg.system) {
      elements.push(
        <div
          key={msg.id}
          className="flex justify-center py-1"
          role="status"
        >
          <span className="text-xs italic text-muted-foreground">
            {msg.body}
          </span>
        </div>,
      );
    } else {
      const u = userMap[msg.authorID];
      // Server data is authoritative once populated (Send updates the
      // root and broadcasts message.edited). Only fall through to
      // page-derived metadata when the server fields are missing —
      // covers thread roots that predate the feature.
      const derived = threadMeta.get(msg.id);
      const needsBackfill =
        derived &&
        ((msg.recentReplyAuthorIDs?.length ?? 0) === 0 || !msg.lastReplyAt);
      const augmented: Message = needsBackfill
        ? {
            ...msg,
            recentReplyAuthorIDs: msg.recentReplyAuthorIDs?.length
              ? msg.recentReplyAuthorIDs
              : derived.authors,
            lastReplyAt: msg.lastReplyAt ?? derived.lastReplyAt,
          }
        : msg;
      elements.push(
        <MessageItem
          key={msg.id}
          message={augmented}
          authorName={u?.displayName ?? 'Unknown'}
          authorAvatarURL={u?.avatarURL}
          authorOnline={u?.online}
          isOwn={msg.authorID === currentUserId}
          channelId={channelId}
          channelSlug={channelSlug}
          conversationId={conversationId}
          currentUserId={currentUserId}
          onReplyInThread={onReplyInThread}
          userMap={userLookup}
        />,
      );
    }
  }

  // Normal top-to-bottom flow: loadMore sentinel is at the top, the
  // messages container is below. The browser's native scroll anchoring
  // (overflow-anchor: auto by default) keeps the user's reading
  // position stable when content above the viewport changes height —
  // older pages prepending, thread reply counts updating on the root
  // message, reactions added to messages above, etc. We deliberately
  // do NOT add manual scrollTop adjustments on top of that; doubling
  // up causes overshoot.
  return (
    <div
      className="flex-1 overflow-y-auto"
      ref={scrollRef}
    >
      {hasNextPage && (
        <div
          ref={loadMoreRef}
          data-testid="message-list-load-more"
          // Fixed height so the appearance/disappearance of the
          // "Loading…" text doesn't shift content underneath. The
          // anchor-restore logic above handles real content shifts;
          // this just keeps the sentinel itself stable.
          className="flex h-8 items-center justify-center text-xs text-muted-foreground"
        >
          {isFetchingNextPage ? 'Loading earlier messages…' : ''}
        </div>
      )}
      <div className="p-4 space-y-1">
        {elements}
        {allMessages.length === 0 && (
          <p
            data-testid="empty-message-list"
            className="py-8 text-center text-muted-foreground"
          >
            No messages yet. Start the conversation!
          </p>
        )}
      </div>
    </div>
  );
}
