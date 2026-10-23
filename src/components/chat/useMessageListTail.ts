import { useEffect, useRef, type RefObject } from 'react';
import type { MessageListRow } from './MessageListRows';

// The list keeping the newest messages in view: while it settles after
// mounting, and when the reader's own message lands.

// How long after mount the list keeps re-aiming at the bottom while rows
// settle from their estimated height to their real one, and how many
// consecutive frames at the bottom count as settled.
const INITIAL_BOTTOM_SETTLE_MS = 1500;
const INITIAL_BOTTOM_STABLE_FRAMES = 10;
// Frames to keep re-scrolling after the user's own send, so the composer's
// post-send height collapse can't leave the list parked above the bottom.
const OWN_SEND_SCROLL_FRAMES = 4;

// Opening at the tail: a chat whose cached history spans several pages
// mounts with hundreds of rows at the estimated height, and the first
// bottom scroll lands short as they measure (hundreds of px with 6 pages).
// Virtuoso's own corrections then move scrollTop and read like a user
// scroll-up to onScroll, which suppresses the tail-follow — so the list sat
// above the newest messages. Keep re-aiming at the bottom for a short
// window after mount; only the person scrolling themselves ends it early.
export function useInitialBottomSettle({
  enabled,
  scrollerRef,
  userScrolledRef,
  atBottomThresholdPx,
  scrollToBottom,
}: {
  // Mount-only: read once (the list remounts per chat session).
  enabled: boolean;
  scrollerRef: RefObject<HTMLElement | null>;
  userScrolledRef: RefObject<boolean>;
  atBottomThresholdPx: number;
  scrollToBottom: () => void;
}) {
  useEffect(() => {
    if (!enabled) return;
    const deadline = performance.now() + INITIAL_BOTTOM_SETTLE_MS;
    let stableFrames = 0;
    let raf = requestAnimationFrame(function step() {
      if (userScrolledRef.current) return;
      const scroller = scrollerRef.current;
      if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > atBottomThresholdPx) {
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
}

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
export function useScrollToOwnSend({
  anchorMsgId,
  rows,
  currentUserId,
  scrollToBottom,
}: {
  anchorMsgId?: string;
  rows: MessageListRow[];
  currentUserId?: string;
  scrollToBottom: () => void;
}) {
  const lastBottomMessageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (anchorMsgId) return;
    if (rows.length === 0) {
      lastBottomMessageIdRef.current = undefined;
      return;
    }
    const last = rows[rows.length - 1];
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
  }, [anchorMsgId, rows, currentUserId, scrollToBottom]);
}
