import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageItem } from './MessageItem';
import { formatDayHeading } from '@/lib/format';
import { deriveThreadMeta } from '@/lib/message-users';
import type { Message, UserStatus } from '@/types';
import { buildMessageListRows, nextVirtuosoState } from './MessageListRows';
import { shouldAutoStickMessageList } from './message-list-autostick';

const ANCHOR_HIGHLIGHT_MS = 2200;
const DEFAULT_MESSAGE_ROW_HEIGHT = 88;
const MESSAGE_LIST_OVERSCAN_PX = 600;

// firstItemIndex is shifted down on every prepend (older-page fetch)
// so Virtuoso identifies prepended rows as preceding existing ones
// rather than displacing them. Starting high enough that we won't
// reach 0 in any reasonable session.
const VIRTUOSO_START_INDEX = 1_000_000;

export interface UserMapEntry {
  displayName: string;
  avatarURL?: string;
  userStatus?: UserStatus;
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
  onEditMessage?: (message: Message) => void;
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
  onEditMessage,
  intro,
  anchorMsgId,
  anchorRevision,
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const atBottomRef = useRef(true);

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

  // Pages are newest-first; reverse to chronological for rendering.
  const allMessages = useMemo(
    () => pages.flatMap((p) => p.items).reverse(),
    [pages],
  );
  const threadMeta = useMemo(() => deriveThreadMeta(allMessages), [allMessages]);
  const rows = useMemo(() => buildMessageListRows(allMessages), [allMessages]);

  // `data` and `firstItemIndex` must reach Virtuoso in the SAME render
  // (its prepend contract). One useState with both fields + a sync
  // layout effect gives us that atomicity even though React Query owns
  // the data.
  const [virtuosoData, setVirtuosoData] = useState<{ rows: typeof rows; firstItemIndex: number }>(() => ({
    rows,
    firstItemIndex: VIRTUOSO_START_INDEX,
  }));
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVirtuosoData((prev) => nextVirtuosoState(prev, rows));
  }, [rows]);

  // Belt-and-braces vs initialTopMostItemIndex: data may arrive after
  // mount, so we re-scroll inside an effect once anchorIndex resolves.
  const anchorIndex = anchorMsgId
    ? virtuosoData.rows.findIndex((r) => r.kind === 'message' && r.message.id === anchorMsgId)
    : -1;
  // React-driven (not classList.add on getElementById) because the
  // DOM element doesn't exist yet on first paint for off-viewport
  // anchors — the timeout would race virtuoso's render.
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
    const scrollFrame = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: anchorIndex, align: 'center' });
    });
    setHighlightedMessageId(anchorMsgId);
    const flashId = window.setTimeout(() => {
      setHighlightedMessageId((curr) => (curr === anchorMsgId ? null : curr));
    }, ANCHOR_HIGHLIGHT_MS);
    return () => {
      cancelAnimationFrame(scrollFrame);
      window.clearTimeout(flashId);
    };
  }, [anchorMsgId, anchorRevision, anchorIndex]);

  // Render against the synced internal state, not the freshly arrived
  // `rows` prop — this is what guarantees `data` and `firstItemIndex`
  // hit Virtuoso atomically.
  const renderRows = virtuosoData.rows;
  const handleContentHeightChange = useCallback(() => {
    if (!shouldAutoStickMessageList({
      anchorMsgId,
      hasPreviousPage,
      atBottom: atBottomRef.current,
    })) {
      return;
    }
    requestAnimationFrame(() => {
      virtuosoRef.current?.autoscrollToBottom();
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
    });
  }, [anchorMsgId, hasPreviousPage]);

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
  const lastBottomMessageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (anchorMsgId) return;
    if (renderRows.length === 0) {
      lastBottomMessageIdRef.current = undefined;
      return;
    }
    const last = renderRows[renderRows.length - 1];
    if (last.kind !== 'message') return;
    const bottomId = last.message.id;
    const previousBottomId = lastBottomMessageIdRef.current;
    lastBottomMessageIdRef.current = bottomId;
    if (!previousBottomId || previousBottomId === bottomId) return;
    if (last.message.authorID !== currentUserId) return;
    if (last.message.parentMessageID) return;
    const scrollFrame = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
    });
    return () => cancelAnimationFrame(scrollFrame);
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
      computeItemKey={(_index, row) => row.key}
      defaultItemHeight={DEFAULT_MESSAGE_ROW_HEIGHT}
      increaseViewportBy={{ top: MESSAGE_LIST_OVERSCAN_PX, bottom: MESSAGE_LIST_OVERSCAN_PX }}
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
            onEditMessage={onEditMessage}
            highlighted={row.message.id === highlightedMessageId}
            onContentHeightChange={handleContentHeightChange}
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
  onEditMessage,
  highlighted,
  onContentHeightChange,
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
  onEditMessage?: (message: Message) => void;
  highlighted?: boolean;
  onContentHeightChange?: () => void;
}) {
  const msg = row.message;
  const handleContentHeightChange = useCallback(() => {
    onContentHeightChange?.();
  }, [onContentHeightChange]);

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
        authorUserStatus={u?.userStatus}
        authorOnline={u?.online}
        isOwn={msg.authorID === currentUserId}
        channelId={channelId}
        channelSlug={channelSlug}
        conversationId={conversationId}
        currentUserId={currentUserId}
        onReplyInThread={onReplyInThread}
        onEditMessage={onEditMessage}
        userMap={userLookup}
        highlighted={highlighted}
        onContentHeightChange={handleContentHeightChange}
      />
    </div>
  );
}
