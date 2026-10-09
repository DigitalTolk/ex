import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageItem } from './MessageItem';
import { formatDayHeading } from '@/lib/format';
import { deriveThreadMeta, isOwnMessage, type ThreadMeta } from '@/lib/message-users';
import type { Message, UserStatus } from '@/types';
import { buildMessageListRows, nextVirtuosoState } from './MessageListRows';
import { shouldAutoStickMessageList } from './message-list-autostick';
import { NewBelowPill, UnreadBanner, UnreadDivider } from './UnreadMarkers';
import {
  clearMissedArrivals,
  isAtBottom,
  markUnreadSeen,
  setAtLiveTail,
  setUnreadAnchor,
  useMissedArrivals,
  useUnreadAnchor,
  useUnreadSeen,
  type UnreadAnchor,
} from '@/lib/read-position';
import { resolveUnreadDivider, unreadFrom } from '@/lib/unread-divider';
import { useUnreadThreadIDs } from '@/hooks/useUnreadThreads';
import { MessageRowDataProvider } from './MessageRowDataProvider';

const ANCHOR_HIGHLIGHT_MS = 2200;
// Estimate for rows Virtuoso hasn't measured yet. It books a prepended page
// of older messages at this height and then corrects the scroll position as
// the rows measure; every correction moves what the reader is looking at, so
// the estimate must sit close to the real average. Measured in ~sandbox:
// grouped rows 24px, header rows ~52px; the newest rows average 33px and
// long runs of grouped history 26px. The old 88 booked a 50-row page ~2700px
// too tall and the corrections showed as jitter when scrolling up fast.
const DEFAULT_MESSAGE_ROW_HEIGHT = 30;
// Longest the loading skeletons may cover a list that hasn't painted rows.
const LIST_PAINT_CAP_MS = 2000;
// Tailwind's animate-pulse cycle.
const SKELETON_PULSE_MS = 2000;
// Overscan kept generous so rows ~2 screens above and below the
// viewport stay mounted during fast scrolling. Without this, every
// off-screen → on-screen transition tears down and rebuilds the row,
// which makes avatar / Giphy / unfurl content flash even when the
// underlying bytes are sitting in the HTTP cache.
const MESSAGE_LIST_OVERSCAN_PX = 2000;
const MESSAGE_LIST_AT_BOTTOM_THRESHOLD_PX = 4;
const USER_SCROLL_AUTOSTICK_SUPPRESSION_MS = 1200;

// Virtuoso's synchronous resize corrections (see the prop below) make WebKit
// drop every rendered row after a scroll — the list goes blank on iOS and
// Safari — while on Chromium they are what stops the flash when a prepended
// page measures shorter than its estimate. Chromium only.
const SYNC_RESIZE_CORRECTIONS =
  typeof navigator !== 'undefined' &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|CriOS|Edg/.test(navigator.userAgent)
    ? false
    : true;

// firstItemIndex is shifted down on every prepend (older-page fetch)
// so Virtuoso identifies prepended rows as preceding existing ones
// rather than displacing them. Starting high enough that we won't
// reach 0 in any reasonable session.
const VIRTUOSO_START_INDEX = 1_000_000;

export interface UserMapEntry {
  displayName: string;
  avatarURL?: string;
  userStatus?: UserStatus;
}

type OlderPaging = Pick<MessageListProps, 'hasNextPage' | 'isFetchingNextPage' | 'fetchNextPage'>;

function loadOlder({ hasNextPage, isFetchingNextPage, fetchNextPage }: OlderPaging) {
  if (hasNextPage && !isFetchingNextPage) fetchNextPage();
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
  // Viewer's most-used emoji shortcodes, forwarded to each message's action
  // bar as one-tap reaction shortcuts.
  quickReactions?: string[];
  // Read lifecycle hooks (see useReadSession): the user reached / left the
  // live tail, and the unread banner's "Mark as read".
  onAtBottomChange?: (atBottom: boolean) => void;
  onMarkAllRead?: () => void;
  // Switch a link-opened window of older history to the newest messages.
  onJumpToLatest?: () => void;
}

// Older pages the unread banner's "Jump" will pull looking for the first
// unread message before settling for the oldest loaded one.
const UNREAD_JUMP_MAX_PAGES = 10;
// Re-aims for a scroll to the "New messages" line (see scrollToDivider).
const UNREAD_SCROLL_ATTEMPTS = 3;
// How long after mount the list keeps re-aiming at the bottom while rows
// settle from their estimated height to their real one (see settle effect),
// and how many consecutive frames at the bottom count as settled.
const INITIAL_BOTTOM_SETTLE_MS = 1500;
const INITIAL_BOTTOM_STABLE_FRAMES = 10;

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
  quickReactions,
  onAtBottomChange,
  onMarkAllRead,
  onJumpToLatest,
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  // Tracks whether the user is parked at the live tail. Driven purely by the
  // scroll handler below (true when scrolled to the bottom, false when the
  // user scrolls up) — deliberately NOT by Virtuoso's atBottomStateChange.
  // When the bottom message grows (image decode pushes the tail below the
  // viewport) Virtuoso reports atBottom=false, but pure content growth fires
  // no scroll event to set it back. If the content-height re-stick gate read
  // that transient false it would race the ResizeObserver and intermittently
  // refuse to re-stick (the webkit "184px from bottom" flake). The scroll
  // handler only flips this on genuine user scrolls, so growth can't poison it.
  const atBottomRef = useRef(true);
  const lastScrollerTopRef = useRef(0);
  const autoStickSuppressedUntilRef = useRef(0);
  const detachScrollerRef = useRef<(() => void) | null>(null);

  // Ready gate: Virtuoso can fire `startReached` during its initial
  // measurement pass before the user has actually scrolled — most
  // visibly when an `initialTopMostItemIndex` deep-link puts the
  // user mid-list and the around-window's first item is briefly
  // considered "visible" while layout settles. The HAR for a
  // deep-link load showed a `cursor=` older-fetch firing 147ms
  // after the `around=` initial fetch with no user interaction;
  // 250ms after mount is enough for Virtuoso to commit the
  // initialTopMostItemIndex scroll.
  // No `readyForFetchRef`. A previous version gated both
  // `startReached` and `endReached` behind a 250ms timer to suppress
  // a layout-settling false positive — Virtuoso briefly reports the
  // first row as visible while committing the deep-link anchor scroll,
  // and that fired a spurious `cursor=` older fetch ~150ms after
  // mount. The cure was worse than the disease: Virtuoso fires each
  // side once on initial layout when the small around-window fits
  // the viewport with the anchor centred, and the guard dropped
  // those single fires, leaving the user pinned to the loaded slice
  // with no way to reach older OR newer messages. Both directions
  // now fire immediately; the single eager fetch is harmless (data
  // we'd need anyway as soon as the user scrolls), and the
  // `isFetchingNextPage` / `isFetchingPreviousPage` checks below
  // coalesce any duplicate fires during settling.

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
  const unreadThreads = useUnreadThreadIDs();

  // The "New messages" line (lib/read-position): where this visit's unread
  // starts. A count anchor — the unread count when the chat was opened — is
  // resolved to a message once and then frozen, so arrivals can't shift it.
  // Opening always lands on the newest messages; a line above the viewport
  // shows as the banner. Once the line has been seen it retires (see
  // UnreadDivider): its row stays, invisible, so nothing shifts, and the
  // banner and pill go with it.
  const readKey = channelId ?? conversationId;
  const parentType = channelId ? 'channel' : 'conversation';
  // A count ("the last N messages") only means something at the live tail: in
  // a link-opened window of older history it would count back from the wrong
  // end, so it waits (the missed-arrivals pill covers what's newer).
  const storedAnchor = useUnreadAnchor(readKey);
  const unreadAnchor = storedAnchor?.kind === 'count' && hasPreviousPage ? undefined : storedAnchor;
  const unreadDividerID = useMemo(
    () => (unreadAnchor ? resolveUnreadDivider(unreadAnchor, allMessages, parentType) : null),
    [unreadAnchor, allMessages, parentType],
  );
  useEffect(() => {
    if (!readKey || unreadAnchor?.kind !== 'count' || !unreadDividerID) return;
    setUnreadAnchor(readKey, { kind: 'message', messageID: unreadDividerID }, { replace: true });
  }, [readKey, unreadAnchor, unreadDividerID]);
  const unreadSeen = useUnreadSeen(readKey);
  const retireDivider = useCallback(() => {
    if (readKey) markUnreadSeen(readKey);
  }, [readKey]);
  const rows = useMemo(() => buildMessageListRows(allMessages, unreadDividerID), [allMessages, unreadDividerID]);

  // `data` and `firstItemIndex` must reach Virtuoso in the SAME render
  // (its prepend contract). One useState with both fields + a sync
  // layout effect gives us that atomicity even though React Query owns
  // the data.
  const [virtuosoData, setVirtuosoData] = useState<{ rows: typeof rows; firstItemIndex: number }>(() => ({
    rows,
    firstItemIndex: VIRTUOSO_START_INDEX,
  }));
  useLayoutEffect(() => {
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
  // Held while the person hasn't scrolled since a link landed. Virtuoso asks
  // for an older page right away (the top of the small window is within its
  // overscan), and inserting it above the linked message shifts it by the
  // rows' estimated height (88px each; real rows are far shorter) — the view
  // drifted down, to the bottom in a short chat. So that page waits until the
  // person scrolls up (see onScroll); scrolling or jumping to the unread line
  // lets go.
  const anchorHeldRef = useRef(!!anchorMsgId);
  // Set once the person scrolls themselves (wheel/touch/key); ends the
  // initial bottom settle below.
  const userScrolledRef = useRef(false);
  const olderWaitingRef = useRef(false);
  const olderPagingRef = useRef<OlderPaging>({ hasNextPage, isFetchingNextPage, fetchNextPage });
  useLayoutEffect(() => {
    anchorHeldRef.current = !!anchorMsgId;
  }, [anchorMsgId, anchorRevision]);

  // See ListCover: lifted once the first rows are rendered.
  const coverRef = useRef<ListCoverHandle>(null);
  // Scroll-to-anchor. Keyed on anchorIndex too, because the index shifts when
  // Virtuoso prepends an older page and we must re-issue scrollToIndex at the
  // corrected position; the dedup guard keeps that to exactly one scroll per
  // anchor. The flash highlight is deliberately NOT in this effect — see below.
  useEffect(() => {
    if (!anchorMsgId) {
      anchorAppliedRef.current = null;
      return;
    }
    if (anchorIndex === -1) return;
    const dedupKey = anchorRevision ? `${anchorMsgId}@${anchorRevision}` : anchorMsgId;
    if (anchorAppliedRef.current === dedupKey) return;
    const scrollFrame = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({ index: anchorIndex, align: 'center' });
      // Record "applied" only AFTER the scroll actually runs. On a cold
      // deeplink / notification open the `around` window mounts with the
      // anchor present, but Virtuoso's natural startReached prepends an
      // older page moments later — shifting anchorIndex and re-running this
      // effect. The cleanup cancels this frame before it fires; recording
      // the dedup up-front (the old bug) then made the re-run bail, so the
      // scroll was lost and the deeplink landed nowhere until a manual
      // retry. Recording here instead lets the re-run re-schedule at the
      // corrected index, while still firing scrollToIndex exactly once (the
      // frame is cancelled, never re-fired — no timer chase).
      anchorAppliedRef.current = dedupKey;
    });
    return () => cancelAnimationFrame(scrollFrame);
  }, [anchorMsgId, anchorRevision, anchorIndex]);

  // Deep-link flash highlight. Keyed on the anchor IDENTITY (anchorMsgId +
  // anchorRevision), never anchorIndex. This is load-bearing: when it lived in
  // the scroll effect above, a page prepend that shifted anchorIndex re-ran the
  // effect, whose cleanup cancelled the pending clear timer while the dedup
  // early-return skipped re-arming it — so the ring stuck forever (the "never
  // de-highlights" regression). Tying the timer to the anchor identity means an
  // index shift can't tear it down: set the ring once per anchor, clear it after
  // the flash window. cleanup guarantees only the current anchor's timer is
  // ever live, so the clear is unconditional.
  useEffect(() => {
    if (!anchorMsgId) {
      setHighlightedMessageId(null);
      return;
    }
    setHighlightedMessageId(anchorMsgId);
    const flashId = window.setTimeout(() => {
      setHighlightedMessageId(null);
    }, ANCHOR_HIGHLIGHT_MS);
    return () => window.clearTimeout(flashId);
  }, [anchorMsgId, anchorRevision]);

  // Render against the synced internal state, not the freshly arrived
  // `rows` prop — this is what guarantees `data` and `firstItemIndex`
  // hit Virtuoso atomically.
  const renderRows = virtuosoData.rows;
  const isAutoStickSuppressed = useCallback(
    () => performance.now() < autoStickSuppressedUntilRef.current,
    [],
  );
  const canAutoStickToBottom = useCallback(() => shouldAutoStickMessageList({
    anchorMsgId,
    hasPreviousPage,
    atBottom: atBottomRef.current,
    autoStickSuppressed: isAutoStickSuppressed(),
  }), [anchorMsgId, hasPreviousPage, isAutoStickSuppressed]);
  const followLiveOutput = useCallback((isAtBottom: boolean) => (
    shouldAutoStickMessageList({
      anchorMsgId,
      hasPreviousPage,
      atBottom: isAtBottom,
      autoStickSuppressed: isAutoStickSuppressed(),
    }) ? 'auto' : false
  ), [anchorMsgId, hasPreviousPage, isAutoStickSuppressed]);
  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.autoscrollToBottom?.();
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end' });
    /* istanbul ignore next -- scrollToBottom only runs after the list has mounted and handleScrollerRef has captured the scroller, so scrollerRef.current is set; the null arm is defensive. */
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, []);

  // When a row's content height changes (image decoded, embed
  // rendered, font swapped), scroll to the live tail — but only if
  // the user is currently auto-sticking to bottom. The tricky part
  // is that some growth happens across multiple paint frames (image
  // → next-frame layout → wider image → final layout). Instead of
  // a fixed 3-frame cascade, we iterate until scrollHeight is
  // stable for one frame OR we hit a generous cap.
  //
  // Stabilization-based replaces the previous cargo-cult fixed
  // cascade: it stops as soon as the content actually settles
  // (saving frames in the common case) and continues longer for
  // slow image decodes that the prior 3-frame budget could miss.
  const SCROLL_STABILIZE_MAX_FRAMES = 8;
  // Frames to keep re-scrolling after the user's own send, so the composer's
  // post-send height collapse can't leave the list parked above the bottom.
  const OWN_SEND_SCROLL_FRAMES = 4;
  // Fired by a row's onContentHeightChange when its box grows after an async
  // image/embed decode. That signal can't be produced deterministically from
  // a test (no real network image decode in the headless harness), so the
  // multi-frame stabilization chase below — including its scroller-null `?? -1`
  // fallbacks, the mid-chase suppression re-check, and the stabilize/cap
  // exit — is irreducible for branch coverage. The behaviour is covered
  // indirectly by the own-message and image-load tests that drive scrollToBottom.
  /* istanbul ignore next -- image-decode-driven content-height growth is not reproducible in the headless test harness; the stabilization chase and its defensive scroller-null fallbacks are irreducible. */
  const handleContentHeightChange = useCallback(() => {
    if (!canAutoStickToBottom()) return;
    let lastHeight = scrollerRef.current?.scrollHeight ?? -1;
    const chase = (frames: number) => {
      requestAnimationFrame(() => {
        if (!canAutoStickToBottom()) return;
        scrollToBottom();
        const next = scrollerRef.current?.scrollHeight ?? -1;
        if (next === lastHeight || frames <= 1) return;
        lastHeight = next;
        chase(frames - 1);
      });
    };
    chase(SCROLL_STABILIZE_MAX_FRAMES);
  }, [canAutoStickToBottom, scrollToBottom]);

  // --- Unread line visibility -------------------------------------------
  // Where the line is relative to the viewport drives the banner (above) and
  // the pill (below). Mounted → measured against the scroller; virtualized
  // away → judged from Virtuoso's rendered range; not loaded at all (older
  // than the loaded history) → above.
  const dividerIndex = unreadDividerID ? renderRows.findIndex((r) => r.kind === 'unread') : -1;
  const dividerStateRef = useRef({ anchored: false, dividerIndex: -1, firstItemIndex: VIRTUOSO_START_INDEX });
  const renderedRangeRef = useRef<{ startIndex: number; endIndex: number } | null>(null);
  const [dividerPos, setDividerPos] = useState<'above' | 'below' | null>(null);
  const dividerPosRef = useRef<'above' | 'below' | null>(null);
  const measureFrameRef = useRef(0);
  const measureDivider = useCallback(() => {
    measureFrameRef.current = 0;
    const { anchored, dividerIndex: index, firstItemIndex } = dividerStateRef.current;
    let pos: 'above' | 'below' | null = null;
    const scroller = scrollerRef.current;
    const el = scroller?.querySelector('[data-unread-divider]');
    if (!anchored) {
      pos = null;
    } else if (index < 0) {
      pos = 'above';
    } else if (scroller && el) {
      const line = el.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if (line.bottom < view.top) pos = 'above';
      else if (line.top > view.bottom) pos = 'below';
    } else if (renderedRangeRef.current) {
      pos = firstItemIndex + index < renderedRangeRef.current.startIndex ? 'above' : 'below';
    }
    if (pos === dividerPosRef.current) return;
    dividerPosRef.current = pos;
    setDividerPos(pos);
  }, []);
  const scheduleDividerMeasure = useCallback(() => {
    if (measureFrameRef.current) return;
    measureFrameRef.current = requestAnimationFrame(measureDivider);
  }, [measureDivider]);
  useLayoutEffect(() => {
    dividerStateRef.current = { anchored: !!unreadAnchor, dividerIndex, firstItemIndex: virtuosoData.firstItemIndex };
    scheduleDividerMeasure();
  }, [unreadAnchor, dividerIndex, virtuosoData.firstItemIndex, scheduleDividerMeasure]);
  useEffect(
    () => () => {
      cancelAnimationFrame(measureFrameRef.current);
      // Reset too: StrictMode's dev remount would otherwise leave a cancelled
      // frame "pending" and skip every later measure.
      measureFrameRef.current = 0;
    },
    [],
  );

  // The banner/pill retire once the user comes back down to the live tail
  // after this line was drawn — they've seen everything below it. Keyed by
  // the anchor itself, so a return to the tail before it existed doesn't
  // count (only a return does: the list mounts at the tail).
  const [caughtUpFor, setCaughtUpFor] = useState<UnreadAnchor | undefined>(undefined);
  const unreadAnchorRef = useRef<UnreadAnchor | undefined>(undefined);
  const onAtBottomChangeRef = useRef(onAtBottomChange);
  const hasPreviousPageRef = useRef(hasPreviousPage);
  useLayoutEffect(() => {
    unreadAnchorRef.current = unreadAnchor;
    onAtBottomChangeRef.current = onAtBottomChange;
    hasPreviousPageRef.current = hasPreviousPage;
    olderPagingRef.current = { hasNextPage, isFetchingNextPage, fetchNextPage };
  });
  const markAtBottom = useCallback((atBottom: boolean) => {
    if (atBottomRef.current === atBottom) return;
    atBottomRef.current = atBottom;
    if (atBottom) setCaughtUpFor(unreadAnchorRef.current);
    // The bottom of a window of older history isn't the bottom of the chat.
    onAtBottomChangeRef.current?.(atBottom && !hasPreviousPageRef.current);
  }, []);

  // A window opened from a link may not reach the newest messages; arrivals
  // it can't show are counted (ChatPage) for the pill below, and forgotten
  // once the window reaches the live tail.
  useEffect(() => {
    if (!readKey) return;
    setAtLiveTail(readKey, !hasPreviousPage);
    if (!hasPreviousPage) clearMissedArrivals(readKey);
    // Tell the read session if this list stands somewhere else than it last
    // heard: a fresh list (e.g. after jumping to the newest messages) mounts
    // at the tail without the scroll transition markAtBottom reports.
    const atBottom = atBottomRef.current && !hasPreviousPage;
    if (atBottom !== isAtBottom(readKey)) onAtBottomChangeRef.current?.(atBottom);
  }, [readKey, hasPreviousPage]);
  const missedArrivals = useMissedArrivals(readKey);

  // Scroll the line (or, for one older than everything loaded, the top) to
  // the top of the viewport. Rows start at an estimated height, so the first
  // scrollToIndex can land short: give the list two frames to settle, check,
  // and re-aim at the line's current index.
  const scrollToDivider = useCallback((target: 'divider' | 'top') => {
    // A programmatic scroll up must not be undone by the tail-follow.
    autoStickSuppressedUntilRef.current = performance.now() + USER_SCROLL_AUTOSTICK_SUPPRESSION_MS;
    let attempts = 0;
    const check = () => {
      const scroller = scrollerRef.current;
      /* istanbul ignore next -- the scroller is attached before any divider can render; defensive. */
      if (!scroller) return;
      // 'top' needs no check; the line must be mounted and inside the view.
      const rect = target === 'divider' ? scroller.querySelector('[data-unread-divider]')?.getBoundingClientRect() : null;
      const view = scroller.getBoundingClientRect();
      const onScreen = target === 'top' || (!!rect && rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1);
      attempts += 1;
      if (!onScreen && attempts < UNREAD_SCROLL_ATTEMPTS) {
        aim();
        return;
      }
      markAtBottom(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= MESSAGE_LIST_AT_BOTTOM_THRESHOLD_PX);
    };
    const aim = () => {
      const index = target === 'top' ? 0 : dividerStateRef.current.dividerIndex;
      virtuosoRef.current?.scrollToIndex({ index, align: 'start' });
      requestAnimationFrame(() => requestAnimationFrame(check));
    };
    aim();
  }, [markAtBottom]);

  // Opening at the tail: a chat whose cached history spans several pages
  // mounts with hundreds of rows at the estimated height, and the first
  // bottom scroll lands short as they measure (hundreds of px with 6 pages).
  // Virtuoso's own corrections then move scrollTop and read like a user
  // scroll-up to onScroll, which suppresses the tail-follow — so the list sat
  // above the newest messages. Keep re-aiming at the bottom for a short
  // window after mount; only the person scrolling themselves ends it early.
  useEffect(() => {
    if (anchorMsgId || hasPreviousPage) return;
    const deadline = performance.now() + INITIAL_BOTTOM_SETTLE_MS;
    let stableFrames = 0;
    let raf = requestAnimationFrame(function step() {
      if (userScrolledRef.current) return;
      const scroller = scrollerRef.current;
      if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > MESSAGE_LIST_AT_BOTTOM_THRESHOLD_PX) {
        stableFrames = 0;
        scrollToBottom();
      } else if (++stableFrames >= INITIAL_BOTTOM_STABLE_FRAMES) {
        return;
      }
      if (performance.now() < deadline) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
    // Mount-only: the wrapper remounts per chat session (see MessageList).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Older pages the banner's "Jump" is still pulling in (see below).
  const jumpPagesRef = useRef(0);

  // Drawing or moving the line (e.g. "Mark as unread") adds height above the
  // tail; a user who was following the tail stays pinned to it. Not while a
  // Jump is paging the line in: it is about to scroll there, and the pin
  // would undo it.
  const lastDividerIDRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastDividerIDRef.current === unreadDividerID) return;
    lastDividerIDRef.current = unreadDividerID;
    if (!unreadDividerID || jumpPagesRef.current || !canAutoStickToBottom()) return;
    requestAnimationFrame(scrollToBottom);
  }, [unreadDividerID, canAutoStickToBottom, scrollToBottom]);

  // "Jump" to a line older than the loaded history pages back for it.
  useEffect(() => {
    if (!jumpPagesRef.current || isFetchingNextPage) return;
    if (dividerIndex >= 0) {
      jumpPagesRef.current = 0;
      scrollToDivider('divider');
    } else if (hasNextPage && jumpPagesRef.current < UNREAD_JUMP_MAX_PAGES) {
      jumpPagesRef.current += 1;
      fetchNextPage();
    } else {
      jumpPagesRef.current = 0;
      scrollToDivider('top');
    }
  }, [dividerIndex, hasNextPage, isFetchingNextPage, fetchNextPage, scrollToDivider]);
  const jumpToUnread = useCallback(() => {
    anchorHeldRef.current = false;
    // An explicit jump is as deliberate as a scroll: it ends the opening
    // bottom settle, which would otherwise pull the list back down.
    userScrolledRef.current = true;
    if (dividerIndex >= 0) {
      scrollToDivider('divider');
      return;
    }
    jumpPagesRef.current = 1;
    if (hasNextPage) fetchNextPage();
    else scrollToDivider('top');
  }, [dividerIndex, hasNextPage, fetchNextPage, scrollToDivider]);

  const unreadCount = unreadDividerID
    ? unreadFrom(allMessages, unreadDividerID, parentType)
    : unreadAnchor?.kind === 'count'
      ? unreadAnchor.count
      : 0;
  const showUnreadMarker = !!unreadAnchor && unreadCount > 0 && caughtUpFor !== unreadAnchor && !unreadSeen;

  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    detachScrollerRef.current?.();
    detachScrollerRef.current = null;

    const scroller = ref instanceof HTMLElement ? ref : null;
    scrollerRef.current = scroller;
    if (!scroller) return;

    lastScrollerTopRef.current = scroller.scrollTop;
    const onScroll = () => {
      const nextScrollTop = scroller.scrollTop;
      const previousScrollTop = lastScrollerTopRef.current;
      const distanceFromBottom = scroller.scrollHeight - nextScrollTop - scroller.clientHeight;
      if (nextScrollTop < previousScrollTop && olderWaitingRef.current && !anchorHeldRef.current) {
        olderWaitingRef.current = false;
        loadOlder(olderPagingRef.current);
      }
      if (nextScrollTop < previousScrollTop - 2 && distanceFromBottom > MESSAGE_LIST_AT_BOTTOM_THRESHOLD_PX) {
        autoStickSuppressedUntilRef.current = performance.now() + USER_SCROLL_AUTOSTICK_SUPPRESSION_MS;
        markAtBottom(false);
      } else if (distanceFromBottom <= MESSAGE_LIST_AT_BOTTOM_THRESHOLD_PX) {
        autoStickSuppressedUntilRef.current = 0;
        markAtBottom(true);
      }
      lastScrollerTopRef.current = nextScrollTop;
      scheduleDividerMeasure();
    };
    // The user scrolling themselves lets go of a linked message and ends the
    // initial bottom settle.
    const onUserScroll = () => {
      anchorHeldRef.current = false;
      userScrolledRef.current = true;
    };
    const userScrollEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    scroller.addEventListener('scroll', onScroll, { passive: true });
    for (const type of userScrollEvents) scroller.addEventListener(type, onUserScroll, { passive: true });
    detachScrollerRef.current = () => {
      scroller.removeEventListener('scroll', onScroll);
      for (const type of userScrollEvents) scroller.removeEventListener(type, onUserScroll);
    };
  }, [markAtBottom, scheduleDividerMeasure]);
  useEffect(() => () => {
    detachScrollerRef.current?.();
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
  const lastBottomMessageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (anchorMsgId) return;
    if (renderRows.length === 0) {
      lastBottomMessageIdRef.current = undefined;
      return;
    }
    const last = renderRows[renderRows.length - 1];
    /* istanbul ignore next -- buildMessageListRows always ends with a message row (day dividers only precede messages), so the last row is never a 'day' */
    if (last.kind !== 'message') return;
    const bottomId = last.message.id;
    const previousBottomId = lastBottomMessageIdRef.current;
    lastBottomMessageIdRef.current = bottomId;
    if (!previousBottomId || previousBottomId === bottomId) return;
    if (last.message.authorID !== currentUserId) return;
    /* istanbul ignore next -- buildMessageListRows filters out messages with parentMessageID, so a thread reply can never be the bottom render row */
    if (last.message.parentMessageID) return;
    // Re-scroll across a few frames: sending a multi-line message collapses
    // the composer back to one row right after the send, which grows the
    // list's viewport a frame or two later. A single rAF would scroll to the
    // pre-collapse bottom and then sit above the real bottom.
    let frame = 0;
    let raf = requestAnimationFrame(function step() {
      scrollToBottom();
      frame += 1;
      if (frame < OWN_SEND_SCROLL_FRAMES) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [anchorMsgId, renderRows, currentUserId, scrollToBottom]);

  // Memoize the Virtuoso Header/Footer COMPONENT identities so they only change
  // when their inputs do — defining them inline gave a fresh function every
  // render, which react-virtuoso treats as a new component type and unmounts +
  // remounts the header/footer subtree on every unrelated parent re-render
  // (e.g. a WS message landing elsewhere), flickering the loading indicators.
  // Declared before the empty-state early return to satisfy rules-of-hooks.
  const Header = useMemo(() => {
    const Cmp = () => (
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
    return Cmp;
  }, [intro, hasNextPage, isFetchingNextPage]);

  const Footer = useMemo(() => {
    const Cmp = () =>
      hasPreviousPage ? (
        <div
          data-testid="message-list-load-newer"
          className="flex h-8 items-center justify-center text-xs text-muted-foreground"
        >
          {isFetchingPreviousPage ? 'Loading newer messages…' : ''}
        </div>
      ) : null;
    return Cmp;
  }, [hasPreviousPage, isFetchingPreviousPage]);

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
  return (
    <MessageRowDataProvider parentType={parentType} parentID={readKey}>
    <div className="relative flex min-h-0 flex-1 flex-col">
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
        // Apply size corrections inside the ResizeObserver callback instead
        // of on the next animation frame. With the default, a prepended page
        // that measures shorter than its estimate shrank the scroll height in
        // one frame and had its scroll position compensated in the next, so
        // the content flashed up and back by hundreds of px while scrolling
        // up fast (react-virtuoso#1049). Not on WebKit, where it blanks the
        // list (see SYNC_RESIZE_CORRECTIONS).
        skipAnimationFrameInResizeObserver={SYNC_RESIZE_CORRECTIONS}
        increaseViewportBy={{ top: MESSAGE_LIST_OVERSCAN_PX, bottom: MESSAGE_LIST_OVERSCAN_PX }}
        atBottomThreshold={MESSAGE_LIST_AT_BOTTOM_THRESHOLD_PX}
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
        followOutput={hasPreviousPage ? false : followLiveOutput}
        scrollerRef={handleScrollerRef}
        startReached={() => {
          // Not under a linked message the person is still on — see anchorHeldRef.
          olderWaitingRef.current = anchorHeldRef.current;
          if (!olderWaitingRef.current) loadOlder({ hasNextPage, isFetchingNextPage, fetchNextPage });
        }}
        endReached={() => {
          if (hasPreviousPage && !isFetchingPreviousPage && fetchPreviousPage) {
            fetchPreviousPage();
          }
        }}
        components={{ Header, Footer }}
        rangeChanged={(range) => {
          renderedRangeRef.current = range;
          scheduleDividerMeasure();
        }}
        // Rows mount a frame after the data changes — re-measure the line
        // once they have.
        itemsRendered={(items) => {
          scheduleDividerMeasure();
          if (items.length > 0) coverRef.current!.reveal();
        }}
        itemContent={(_index, row) => {
          /* istanbul ignore next -- react-virtuoso can momentarily call itemContent with an undefined row during prepend/firstItemIndex reconciliation; not deterministically reproducible. */
          if (!row) return null;
          if (row.kind === 'unread') return <UnreadDivider onSeen={retireDivider} retired={unreadSeen} />;
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
              // Only this row's entry: the Map is rebuilt on every list change,
              // and passing it made every mounted row re-render per send.
              threadMetaEntry={threadMeta.get(row.message.id)}
              currentUserId={currentUserId}
              channelId={channelId}
              channelSlug={channelSlug}
              conversationId={conversationId}
              onReplyInThread={onReplyInThread}
              onEditMessage={onEditMessage}
              highlighted={row.message.id === highlightedMessageId}
              onContentHeightChange={handleContentHeightChange}
              quickReactions={quickReactions}
              threadHasNew={unreadThreads.has(row.message.id)}
            />
          );
        }}
        className="flex-1"
      />
      {showUnreadMarker && dividerPos === 'above' ? (
        <UnreadBanner count={unreadCount} onJump={jumpToUnread} onMarkRead={() => onMarkAllRead?.()} />
      ) : null}
      {showUnreadMarker && dividerPos === 'below' ? <NewBelowPill count={unreadCount} onClick={scrollToBottom} /> : null}
      {hasPreviousPage && missedArrivals > 0 ? (
        <NewBelowPill count={missedArrivals} onClick={() => onJumpToLatest?.()} />
      ) : null}
      <ListCover ref={coverRef} />
    </div>
    </MessageRowDataProvider>
  );
}

type ListCoverHandle = { reveal: () => void };

// ListCover keeps the loading skeletons over a freshly mounted list until its
// first rows are on screen: Virtuoso mounts empty and measures for a few
// frames before painting any, which showed as a blank pane between the
// skeletons and the messages. Its own state, so lifting it re-renders only
// the cover, not the list; a cap makes sure it can never get stuck.
function ListCover({ ref }: { ref: Ref<ListCoverHandle> }) {
  const [shown, setShown] = useState(true);
  const frameRef = useRef(0);
  useImperativeHandle(ref, () => ({
    reveal: () => {
      // One frame for the first rows to settle where they belong.
      if (!frameRef.current) frameRef.current = requestAnimationFrame(() => setShown(false));
    },
  }), []);
  useEffect(() => {
    const cap = window.setTimeout(() => setShown(false), LIST_PAINT_CAP_MS);
    return () => {
      window.clearTimeout(cap);
      cancelAnimationFrame(frameRef.current);
    };
  }, []);
  if (!shown) return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-10 flex flex-col bg-background" data-testid="message-list-cover">
      <Skeletons />
    </div>
  );
}

// Skeletons pulse in step with any set shown before them (the delay puts each
// set at the same point of the shared cycle), so handing over from the
// loading set to the one covering the list never restarts the pulse.
function Skeletons() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.style.setProperty('--pulse-delay', `-${Math.round(performance.now() % SKELETON_PULSE_MS)}ms`);
  }, []);
  return (
    <div ref={ref} className="flex-1 p-4 space-y-4 [&_[data-slot=skeleton]]:[animation-delay:var(--pulse-delay)]">
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

type MessageRowProps = {
  row: { kind: 'message'; key: string; message: Message; firstInGroup: boolean };
  userMap: Record<string, UserMapEntry>;
  userLookup: { get(id: string): UserMapEntry | undefined };
  threadMetaEntry?: ThreadMeta;
  currentUserId?: string;
  channelId?: string;
  channelSlug?: string;
  conversationId?: string;
  onReplyInThread?: (id: string) => void;
  onEditMessage?: (message: Message) => void;
  highlighted?: boolean;
  onContentHeightChange?: () => void;
  quickReactions?: string[];
  threadHasNew?: boolean;
};

// buildMessageListRows makes a fresh row object for every message on every
// list change, so a plain memo re-rendered every mounted row (and its emoji
// pickers) on each send — ~300ms of main-thread time per cache update in dev.
// Compare the row by what it holds; the message object itself keeps its
// identity across cache patches unless it changed.
function messageRowPropsEqual(prev: MessageRowProps, next: MessageRowProps): boolean {
  if (prev.row !== next.row) {
    if (
      prev.row.key !== next.row.key ||
      prev.row.message !== next.row.message ||
      prev.row.firstInGroup !== next.row.firstInGroup
    ) {
      return false;
    }
  }
  if (prev.threadMetaEntry !== next.threadMetaEntry) {
    const a = prev.threadMetaEntry;
    const b = next.threadMetaEntry;
    if (!a || !b || a.lastReplyAt !== b.lastReplyAt || a.authors.length !== b.authors.length) return false;
    if (a.authors.some((id, i) => id !== b.authors[i])) return false;
  }
  for (const key of Object.keys(next) as (keyof MessageRowProps)[]) {
    if (key === 'row' || key === 'threadMetaEntry') continue;
    if (prev[key] !== next[key]) return false;
  }
  return true;
}

const MessageRow = memo(function MessageRow({
  row,
  userMap,
  userLookup,
  threadMetaEntry,
  currentUserId,
  channelId,
  channelSlug,
  conversationId,
  onReplyInThread,
  onEditMessage,
  highlighted,
  onContentHeightChange,
  quickReactions,
  threadHasNew,
}: MessageRowProps) {
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
  const derived = threadMetaEntry;
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
        firstInGroup={row.firstInGroup}
        authorName={u?.displayName ?? 'Unknown'}
        authorAvatarURL={u?.avatarURL}
        authorUserStatus={u?.userStatus}
        isOwn={isOwnMessage(msg, currentUserId)}
        channelId={channelId}
        channelSlug={channelSlug}
        conversationId={conversationId}
        currentUserId={currentUserId}
        onReplyInThread={onReplyInThread}
        onEditMessage={onEditMessage}
        userMap={userLookup}
        highlighted={highlighted}
        onContentHeightChange={handleContentHeightChange}
        quickReactions={quickReactions}
        threadHasNew={threadHasNew}
      />
    </div>
  );
}, messageRowPropsEqual);
