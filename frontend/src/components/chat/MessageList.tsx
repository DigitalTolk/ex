import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageItem } from './MessageItem';
import { formatDayHeading } from '@/lib/format';
import { deriveThreadMeta } from '@/lib/message-users';
import type { Message } from '@/types';
import { buildMessageListRows, nextVirtuosoState } from './MessageListRows';

const ANCHOR_HIGHLIGHT_MS = 2200;

// firstItemIndex is shifted down on every prepend (older-page fetch)
// so Virtuoso identifies prepended rows as preceding existing ones
// rather than displacing them. Starting high enough that we won't
// reach 0 in any reasonable session.
const VIRTUOSO_START_INDEX = 1_000_000;

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
  hasPreviousPage?: boolean;
  isFetchingPreviousPage?: boolean;
  fetchPreviousPage?: () => void;
  currentUserId?: string;
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  userMap: Record<string, UserMapEntry>;
  onReplyInThread?: (messageID: string) => void;
  intro?: ReactNode;
  anchorMsgId?: string;
  anchorRevision?: string;
}

export function MessageList(props: MessageListProps) {
  if (props.isLoading) return <Skeletons />;
  // Keying the inner Virtuoso wrapper on channel/conversation/anchor
  // forces a fresh mount per session — Virtuoso's internal state
  // (scroll position, item heights, prepend bookkeeping) all reset
  // cleanly without us having to track a session boundary.
  const sessionKey = `${props.channelId ?? ''}|${props.conversationId ?? ''}|${props.anchorMsgId ?? ''}`;
  return <VirtuosoMessageList key={sessionKey} {...props} />;
}

function VirtuosoMessageList({
  pages,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  hasPreviousPage,
  isFetchingPreviousPage,
  fetchPreviousPage,
  currentUserId,
  channelId,
  channelSlug,
  conversationId,
  userMap,
  onReplyInThread,
  intro,
  anchorMsgId,
  anchorRevision,
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Ready gate: Virtuoso can fire `startReached` during its initial
  // measurement pass before the user has actually scrolled — most
  // visibly when an `initialTopMostItemIndex` deep-link puts the
  // user mid-list and the around-window's first item is briefly
  // considered "visible" while layout settles. The HAR for a
  // deep-link load showed a `cursor=` older-fetch firing 147ms
  // after the `around=` initial fetch with no user interaction;
  // 250ms after mount is enough for Virtuoso to commit the
  // initialTopMostItemIndex scroll.
  const readyForFetchRef = useRef(false);
  useEffect(() => {
    const t = window.setTimeout(() => {
      readyForFetchRef.current = true;
    }, 250);
    return () => window.clearTimeout(t);
  }, []);

  const userLookup = useMemo(
    () => ({ get: (id: string) => userMap[id] }),
    [userMap],
  );

  // Pages are newest-first within and across pages; reverse for
  // chronological order (oldest at top, newest at bottom).
  const allMessages = useMemo(
    () => pages.flatMap((p) => p.items).reverse(),
    [pages],
  );
  const threadMeta = useMemo(() => deriveThreadMeta(allMessages), [allMessages]);
  const rows = useMemo(() => buildMessageListRows(allMessages), [allMessages]);

  // `data` and `firstItemIndex` must update atomically — Virtuoso's
  // own prepend example pairs `setState` calls in one callback so
  // React batches them into a single render. We can't do that
  // because React Query owns the data, but we CAN mirror the same
  // shape by keeping both inside one `useState` and syncing from the
  // `rows` prop in a layout effect. Each transition is one
  // setState → one render → Virtuoso sees both values change in a
  // single diff, exactly matching the documented pattern.
  const [virtuosoData, setVirtuosoData] = useState<{ rows: typeof rows; firstItemIndex: number }>(() => ({
    rows,
    firstItemIndex: VIRTUOSO_START_INDEX,
  }));
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVirtuosoData((prev) => nextVirtuosoState(prev, rows));
  }, [rows]);

  // Deep-link landing: scroll to the anchor message and flash a
  // highlight ring. We always scroll (rather than relying on
  // `initialTopMostItemIndex` for the first application) because
  // data may arrive after the Virtuoso mount, in which case the
  // mount-time index would have been -1 and the prop wouldn't
  // re-trigger when the index later becomes valid.
  const anchorIndex = anchorMsgId
    ? virtuosoData.rows.findIndex((r) => r.kind === 'message' && r.message.id === anchorMsgId)
    : -1;
  // Highlight is React-driven: the anchor effect sets a state value
  // that flows into MessageItem via props, MessageItem renders the
  // ring class when its id matches. Doing it via classList.add on
  // document.getElementById raced with Virtuoso's render — the
  // element didn't exist yet when the timeout fired, especially for
  // thread-root deep-links where the anchor was off-viewport at
  // mount, causing the regression where the parent message in the
  // channel never lit up.
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const anchorAppliedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!anchorMsgId) {
      anchorAppliedRef.current = null;
      return;
    }
    if (anchorIndex === -1) return;
    const dedupKey = anchorRevision ? `${anchorMsgId}@${anchorRevision}` : anchorMsgId;
    if (anchorAppliedRef.current === dedupKey) return;
    anchorAppliedRef.current = dedupKey;
    // Multi-pass scroll: virtuoso's initial scroll uses estimated
    // row heights for unmeasured rows. Thread deep-links are the
    // worst case — ThreadPanel mounts alongside MessageList,
    // narrowing the main scroller's width, so messages wrap to
    // more lines than virtuoso's defaultItemHeight estimate. A
    // single scroll lands wildly off-target; later passes re-
    // assert position once real heights have been measured. The
    // old DOM-based version used scrollIntoView + a 1.5s
    // ResizeObserver to re-center on content settle; this is the
    // virtuoso equivalent. Each pass is a no-op if already on
    // target, so the cost is just three rAF/timer fires.
    const scroll = () =>
      virtuosoRef.current?.scrollToIndex({ index: anchorIndex, align: 'center' });
    requestAnimationFrame(scroll);
    const t1 = window.setTimeout(scroll, 100);
    const t2 = window.setTimeout(scroll, 350);
    const t3 = window.setTimeout(scroll, 800);
    setHighlightedMessageId(anchorMsgId);
    const flashId = window.setTimeout(() => {
      setHighlightedMessageId((curr) => (curr === anchorMsgId ? null : curr));
    }, ANCHOR_HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(flashId);
    };
  }, [anchorMsgId, anchorRevision, anchorIndex]);

  // Render against the synced internal state, not the freshly arrived
  // `rows` prop — this is what guarantees `data` and `firstItemIndex`
  // hit Virtuoso atomically.
  const renderRows = virtuosoData.rows;

  // Track at-bottom for the resize handler below. Virtuoso owns the
  // computation; we just mirror the value into a ref so a non-React
  // ResizeObserver callback can read it without re-subscribing.
  const atBottomRef = useRef(true);

  // When the scroll container shrinks (e.g., the "refresh for new
  // version" banner appears at the top of the page after mount),
  // Virtuoso doesn't auto-snap to the new bottom on its own —
  // the user ends up parked above the live tail by the banner's
  // height. ResizeObserver on the Virtuoso scroller fires on every
  // container resize; if we were at the bottom before the resize,
  // we re-scroll to the last item.
  useEffect(() => {
    const handle = virtuosoRef.current;
    if (!handle) return;
    // Deep-link mounts land the user mid-list at an explicit anchor.
    // Skip the RO + multi-pass snap entirely: those exist to keep a
    // live-tail viewer pinned to the bottom when content/container
    // resizes, and on a deep-link mount they actively fight the
    // anchor scroll. (atBottomRef defaults to true; on mount the RO
    // sees content grow from row measurements, atBottomRef hasn't
    // been corrected yet by atBottomStateChange, so reSnap fires and
    // yanks the user to LAST — exactly the regression where "the
    // page doesn't scroll to the message".)
    if (anchorMsgId) return;
    if (typeof ResizeObserver === 'undefined') return;
    const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller]');
    if (!scroller) return;
    let lastClientHeight = scroller.clientHeight;
    let lastScrollHeight = scroller.scrollHeight;
    const reSnap = () => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
    };
    const ro = new ResizeObserver(() => {
      const ch = scroller.clientHeight;
      const sh = scroller.scrollHeight;
      const containerShrank = ch < lastClientHeight;
      // Content grew AFTER Virtuoso's initial scroll-to-end means
      // an existing item resized post-mount — usually a late-
      // loading avatar / image / unfurl card adding a few pixels.
      // Cached-content channels don't see this because everything's
      // measured by first paint; fresh-fetched channels do, and
      // were ending up 4-5px short of the actual bottom.
      const contentGrew = sh > lastScrollHeight + 0.5;
      lastClientHeight = ch;
      lastScrollHeight = sh;
      if (!atBottomRef.current) return;
      if (containerShrank || contentGrew) reSnap();
    });
    ro.observe(scroller);
    // Inner content size changes (item resize from late image
    // decode, attachment hydration, etc.) don't bubble through the
    // scroller's own ResizeObserver entry, so observe the inner
    // measurement node too. Virtuoso renders it as a direct child
    // of the scroller with `[data-viewport-type]`.
    const inner = scroller.querySelector<HTMLElement>('[data-viewport-type]');
    if (inner) ro.observe(inner);

    if (renderRows.length === 0) return () => ro.disconnect();
    // Multi-pass post-mount snap (live-tail mounts only): any
    // measurement that resizes the scroller BETWEEN initial paint
    // and the RO attaching is missed. For channels with many items
    // Virtuoso's initial estimate-based scroll can land 4-5px short
    // of the actual bottom; the chase below explicitly scrolls to
    // the last item at three increasing delays. Each call is a
    // no-op if we're already there.
    const lastIdx = renderRows.length - 1;
    const snap = () => virtuosoRef.current?.scrollToIndex({ index: lastIdx, align: 'end' });
    const timers = [
      window.setTimeout(snap, 0),
      window.setTimeout(snap, 100),
      window.setTimeout(snap, 350),
    ];
    return () => {
      ro.disconnect();
      timers.forEach((t) => window.clearTimeout(t));
    };
    // Mount-only: anchorMsgId and renderRows.length are captured
    // for the initial-snap chase. The wrapper component keys this
    // mount on channel/anchor changes, so a fresh mount runs the
    // chase with the new values; we don't want it re-firing as
    // rows grow during the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Force-scroll-to-bottom when the bottom message becomes the
  // current user's own send. `followOutput="auto"` only sticks when
  // the user is already at the bottom (within Virtuoso's
  // atBottomThreshold) — but a user scrolled up to read history and
  // then types a new message expects to see THEIR message land
  // visibly. This effect overrides that case: if the new bottom is
  // own-authored and the previous bottom wasn't this message,
  // scrollToIndex regardless of at-bottom state.
  //
  // Skipped when an anchor is set: a deep-link's around-window may
  // include the user's own message in its newer half, and the bottom
  // of the loaded slice is NOT the live tail — we'd be yanking the
  // user away from their anchored position to a half-loaded "fake"
  // bottom.
  const lastOwnBottomRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (anchorMsgId) return;
    if (renderRows.length === 0) {
      lastOwnBottomRef.current = undefined;
      return;
    }
    const last = renderRows[renderRows.length - 1];
    if (last.kind !== 'message') return;
    const bottomId = last.message.id;
    if (lastOwnBottomRef.current === bottomId) return;
    lastOwnBottomRef.current = bottomId;
    if (last.message.authorID !== currentUserId) return;
    if (last.message.parentMessageID) return;
    virtuosoRef.current?.scrollToIndex({
      index: renderRows.length - 1,
      align: 'end',
    });
  }, [anchorMsgId, renderRows, currentUserId]);

  if (renderRows.length === 0) {
    // Empty state: render the intro (channels show "This is the
    // very beginning of …" right away; DMs/groups gate the intro
    // behind their first message at the caller). The placeholder
    // stays as the empty-list signal but renders below the intro.
    return (
      <div className="flex-1 overflow-y-auto">
        {intro ? <div className="px-4 pt-4">{intro}</div> : null}
        <p
          data-testid="empty-message-list"
          className="px-4 py-8 text-center text-muted-foreground"
        >
          No messages yet. Start the conversation!
        </p>
      </div>
    );
  }

  // Intro and message rows use the same px-4 horizontal padding so
  // the "This is the very beginning…" card lines up with the
  // messages below it. Without this wrapper, the intro renders
  // flush-left while messages still get their MessageRow px-4,
  // making the intro visibly shifted after the first message lands.
  const Header = () => (
    <>
      {intro && !hasNextPage ? <div className="px-4 pt-2">{intro}</div> : null}
      {hasNextPage ? (
        <div
          data-testid="message-list-load-more"
          className="flex h-8 items-center justify-center text-xs text-muted-foreground"
        >
          {isFetchingNextPage ? 'Loading earlier messages…' : ''}
        </div>
      ) : null}
    </>
  );

  const Footer = () =>
    hasPreviousPage ? (
      <div
        data-testid="message-list-load-newer"
        className="flex h-8 items-center justify-center text-xs text-muted-foreground"
      >
        {isFetchingPreviousPage ? 'Loading newer messages…' : ''}
      </div>
    ) : null;

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={renderRows}
      firstItemIndex={virtuosoData.firstItemIndex}
      initialTopMostItemIndex={
        anchorIndex >= 0
          ? { index: anchorIndex, align: 'center' }
          : { index: renderRows.length - 1, align: 'end' }
      }
      // alignToBottom is the chat-canonical layout: when the
      // content is shorter than the viewport, items stick to the
      // BOTTOM of the scroller (just above the composer) instead
      // of the default top-anchored flow. Without this, a fresh
      // channel with one message renders the message at the top
      // of the chat area with a tall empty gap below it — exactly
      // what the user reported.
      alignToBottom={true}
      // Auto-follow only when the loaded slice IS the live tail. When
      // hasPreviousPage is true (deep-link mid-history with newer
      // pages still unfetched), disable follow: each forward-pagination
      // append would otherwise snap the user to the new bottom while
      // they're trying to read, which then re-arms endReached and
      // pulls the next page → next snap → next page, until the live
      // tail is hit. The user reported this as "spamming" downward
      // scroll. With hasPreviousPage=false (we're at the live tail)
      // 'auto' still snaps for incoming WS messages when the user is
      // at the bottom — the canonical chat behaviour.
      followOutput={hasPreviousPage ? false : 'auto'}
      atBottomStateChange={(atBottom) => {
        atBottomRef.current = atBottom;
      }}
      startReached={() => {
        if (!readyForFetchRef.current) return;
        if (hasNextPage && !isFetchingNextPage) fetchNextPage();
      }}
      endReached={() => {
        if (!readyForFetchRef.current) return;
        if (hasPreviousPage && !isFetchingPreviousPage && fetchPreviousPage) {
          fetchPreviousPage();
        }
      }}
      components={{ Header, Footer }}
      itemContent={(_index, row) => {
        if (!row) return null;
        return row.kind === 'day' ? (
          <div
            data-testid="day-divider"
            className="flex items-center gap-3 px-4 py-2"
            role="separator"
          >
            <div className="flex-1 border-t border-border" />
            <span className="text-xs font-medium text-muted-foreground">
              {formatDayHeading(row.date)}
            </span>
            <div className="flex-1 border-t border-border" />
          </div>
        ) : (
          <MessageRow
            row={row}
            userMap={userMap}
            userLookup={userLookup}
            threadMeta={threadMeta}
            currentUserId={currentUserId}
            channelId={channelId}
            channelSlug={channelSlug}
            conversationId={conversationId}
            onReplyInThread={onReplyInThread}
            highlighted={row.message.id === highlightedMessageId}
          />
        );
      }}
      className="flex-1"
    />
  );
}

function Skeletons() {
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

function MessageRow({
  row,
  userMap,
  userLookup,
  threadMeta,
  currentUserId,
  channelId,
  channelSlug,
  conversationId,
  onReplyInThread,
  highlighted,
}: {
  row: { kind: 'message'; key: string; message: Message };
  userMap: Record<string, UserMapEntry>;
  userLookup: { get(id: string): UserMapEntry | undefined };
  threadMeta: ReturnType<typeof deriveThreadMeta>;
  currentUserId?: string;
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  onReplyInThread?: (id: string) => void;
  highlighted?: boolean;
}) {
  const msg = row.message;
  if (msg.system) {
    return (
      <div className="flex justify-center px-4 py-1" role="status">
        <span className="text-xs italic text-muted-foreground">{msg.body}</span>
      </div>
    );
  }
  const u = userMap[msg.authorID];
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
  return (
    <div className="px-4">
      <MessageItem
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
        highlighted={highlighted}
      />
    </div>
  );
}
