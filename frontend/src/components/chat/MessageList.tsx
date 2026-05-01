import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageItem } from './MessageItem';
import { useAtBottomRef } from '@/hooks/useAtBottomRef';
import { useLatestRef } from '@/hooks/useLatestRef';
import { dayKey, formatDayHeading } from '@/lib/format';
import { deriveThreadMeta } from '@/lib/message-users';
import type { Message } from '@/types';

const ANCHOR_HIGHLIGHT_CLASSES = ['ring-1', 'ring-amber-400/50', 'rounded-md'];
const ANCHOR_HIGHLIGHT_MS = 2200;

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
  // Newer-direction pagination — only fires when the list was
  // anchored mid-history (deep link).
  hasPreviousPage?: boolean;
  isFetchingPreviousPage?: boolean;
  fetchPreviousPage?: () => void;
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
  // Deep-link target. When set, MessageList lands on this message
  // (centered, with a brief highlight) instead of pinning to the
  // bottom, and does not re-scroll on subsequent page fetches.
  anchorMsgId?: string;
  // Per-navigation revision token (from useLocation().key). Changes
  // on every navigation including re-clicking a Link to the current
  // URL — used in the dedup key so re-clicks re-trigger the scroll
  // even when anchorMsgId is unchanged.
  anchorRevision?: string;
}

export function MessageList({
  pages,
  hasNextPage,
  isFetchingNextPage,
  isLoading,
  fetchNextPage,
  hasPreviousPage,
  isFetchingPreviousPage,
  fetchPreviousPage,
  refetch,
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Tracks the inner messages container — the element whose height
  // changes when avatars/attachments/unfurls finish loading. Both the
  // bottom-stick and the deep-link follow-anchor ResizeObservers
  // observe THIS, not scroller.lastElementChild: in deep-link mode the
  // scroller's last child is the load-newer sentinel (fixed h-8), so
  // observing it would never fire on real content settling.
  const innerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const loadNewerRef = useRef<HTMLDivElement>(null);

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

  // Tracks whether the user is at the bottom of the message list so
  // new arrivals + settling async content can follow them only when
  // they're keeping up with the conversation.
  const wasAtBottomRef = useAtBottomRef(scrollRef);

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
  // userHasScrolledRef is shared with the deep-link anchor effect
  // below — once the user has taken control of the scroll, follow-
  // anchor stops, AND the bottom-stick RO is allowed to fire even in
  // deep-link mode. Declared up here because the bottom-stick effect
  // needs to reference it from its RO callback.
  const userHasScrolledRef = useRef(false);
  const stickyBottomDoneRef = useRef(false);
  const stickyROrRef = useRef<ResizeObserver | null>(null);
  // Tracks the ID of the bottom message in allMessages. Updated by
  // the lastBottom layout effect below, but DECLARED here so the
  // bottom-stick RO can read it from its closure: the RO uses a
  // change in this value as the "new message arrived" signal.
  const lastBottomIdRef = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    // Channel/DM switch — or transitioning into/out of deep-link
    // mode within the same parent — re-arms initial scroll-to-bottom
    // and tears down the previous observer so the next mode sets up
    // its own. Without anchorMsgId in the deps, leaving deep-link
    // mode in the same channel would never re-pin to the bottom.
    stickyBottomDoneRef.current = false;
    if (stickyROrRef.current) {
      stickyROrRef.current.disconnect();
      stickyROrRef.current = null;
    }
  }, [channelId, conversationId, anchorMsgId]);
  useLayoutEffect(() => {
    if (stickyBottomDoneRef.current) return;
    if (allMessages.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const stick = () => {
      el.scrollTop = el.scrollHeight;
      wasAtBottomRef.current = true;
    };
    // Deep-link mode: the anchor effect below controls the initial
    // scroll position. We still install the ResizeObserver so that
    // once the user reaches the live tail (atBottomRef flips true),
    // settling content keeps following along — the gating below
    // ensures the observer is a no-op until then.
    if (!anchorMsgId) {
      stick();
    }
    stickyBottomDoneRef.current = true;
    if (typeof ResizeObserver === 'undefined') return;
    const inner = innerRef.current;
    if (!inner) return;
    // The bottom-stick RO follows live conversation: when a NEW
    // MESSAGE lands at the bottom and the reader is already at the
    // bottom, stick to the new bottom so the new message comes into
    // view. It does NOT fire on:
    //   1. Same-bottom resizes (avatar/attachment loading, reaction
    //      added) — these change scrollHeight but the bottom message
    //      ID stays the same. Following them would yank readers who
    //      happen to be near the bottom (e.g., a deep-link landing
    //      that the browser clamped to within 120px) on every settling
    //      image, making the list feel "locked at the bottom".
    //   2. Scroller width changes (panel toggle, window resize).
    //      Visible-anchor preservation kicks in for that case so the
    //      reader's current message stays visually pinned.
    //
    // The "new message added at the bottom" signal comes from the
    // lastBottomIdRef that the lastBottom layout effect maintains —
    // it's updated synchronously when allMessages's last item changes,
    // before this RO callback fires. We compare against the bottom ID
    // we last SAW here (in this RO's closure), so any RO fire where
    // the bottom didn't change is treated as a no-op resize.
    // The lastBottom layout effect (which populates lastBottomIdRef)
    // runs AFTER this effect, so on first fire the ref may still be
    // undefined. Detect that and treat it as the initial snapshot —
    // not a "new message arrived".
    let lastScrollHeight = el.scrollHeight;
    let lastClientWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const width = el.clientWidth;
      const height = el.scrollHeight;
      const widthDelta = Math.abs(width - lastClientWidth);
      const heightDelta = Math.abs(height - lastScrollHeight);
      // True layout reflow = both width AND height change (panel
      // toggle, window resize). Width-only changes come from overlay-
      // scrollbar appearance during scroll on some platforms.
      const reflow = widthDelta > 24 && heightDelta > 0.5;
      const grew = height > lastScrollHeight + 0.5;
      lastClientWidth = width;
      lastScrollHeight = height;
      if (reflow) {
        // Layout reflow → preserve the reader's visible-anchor
        // position so the browser's clamp-on-shrink doesn't drag
        // them and reflow doesn't shift their reading position.
        // Skipped when the reader is at the live tail (sticking
        // handles them) and in deep-link mode (the anchor effect
        // controls position).
        const anchor = visibleAnchorRef.current;
        if (anchor && !wasAtBottomRef.current) {
          const msg = document.getElementById(`msg-${anchor.id}`);
          if (msg) {
            const scrollerTop = el.getBoundingClientRect().top;
            const currentOffset = msg.getBoundingClientRect().top - scrollerTop;
            const delta = currentOffset - anchor.offset;
            if (Math.abs(delta) > 0.5) {
              el.scrollTop += delta;
            }
          }
        }
        return;
      }
      // Live-tail follow: only in non-anchor mode and only when the
      // reader is already at the live tail. In deep-link mode the
      // reader explicitly went to a specific message — they never
      // opted into live-tail follow, so we never auto-yank them
      // (even when a new message arrives in the loaded set).
      if (anchorMsgId) return;
      if (!grew) return;
      if (wasAtBottomRef.current) stick();
    });
    ro.observe(inner);
    stickyROrRef.current = ro;
  }, [allMessages.length, anchorMsgId, wasAtBottomRef]);
  useEffect(
    () => () => {
      if (stickyROrRef.current) {
        stickyROrRef.current.disconnect();
        stickyROrRef.current = null;
      }
    },
    [],
  );

  // Backup for the bottom-stick RO: late-loading <img> elements
  // (avatars, inline attachments, unfurl thumbs) finish at unpredictable
  // moments. The ResizeObserver above handles most of these, but image
  // load events are themselves the most reliable signal that "this
  // image's box just grew" — capture them at the inner container so a
  // single delegated listener covers every img inside the message list.
  // Gated by wasAtBottomRef so a reader scrolled up doesn't get yanked
  // when an image far above their viewport finishes loading. Skipped
  // in deep-link mode for the same reason as the RO.
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    if (anchorMsgId) return;
    const onLoad = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target || target.tagName !== 'IMG') return;
      if (!wasAtBottomRef.current) return;
      // Defer to the next frame so the browser has a chance to apply
      // the just-loaded image's intrinsic dimensions to layout. Reading
      // scrollHeight synchronously inside the load handler can return
      // the pre-resize value in some browsers, leaving the scroll
      // position one image-height short of the actual bottom.
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    };
    // useCapture=true so img load events (which don't bubble) reach us.
    inner.addEventListener('load', onLoad, true);
    return () => inner.removeEventListener('load', onLoad, true);
  }, [anchorMsgId, wasAtBottomRef]);

  // Scroll anchoring: track the top-most visible message on every
  // scroll. The bottom-stick RO above will use this to preserve
  // reading position when the scroller's WIDTH changes (panel toggle,
  // window resize) — the browser's overflow-anchor: auto doesn't
  // reliably handle that case and can clamp scrollTop, dragging the
  // reader to the live tail.
  const visibleAnchorRef = useRef<{ id: string; offset: number } | null>(null);
  const messagesEmpty = allMessages.length === 0;
  useEffect(() => {
    const scroller = scrollRef.current;
    const inner = innerRef.current;
    if (!scroller || !inner) return;
    const captureTopVisible = () => {
      const scrollerTop = scroller.getBoundingClientRect().top;
      const messages = inner.querySelectorAll<HTMLElement>('[data-message-id]');
      for (const m of messages) {
        const rect = m.getBoundingClientRect();
        if (rect.bottom > scrollerTop) {
          visibleAnchorRef.current = {
            id: m.dataset.messageId ?? '',
            offset: rect.top - scrollerTop,
          };
          return;
        }
      }
      visibleAnchorRef.current = null;
    };
    const onScroll = () => captureTopVisible();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    captureTopVisible();
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [messagesEmpty]);

  // Deep-link landing: when anchorMsgId is set, scroll the matching
  // message into view exactly once per (parent, anchor) and apply a
  // brief highlight ring. We drive this off the prop (not the URL
  // hash) so subsequent newer/older page fetches — which change
  // pages.length — DO NOT re-trigger the scroll, otherwise the user
  // gets yanked back to the anchor every time they try to scroll
  // toward the live tail.
  //
  // The naive "scrollIntoView once" approach has a real-world failure
  // mode: avatars / attachments / unfurl cards above the anchor load
  // asynchronously, growing the content above the viewport, and the
  // anchor drifts off-screen. To survive that, we install a short-
  // lived ResizeObserver that re-centers as long as the user hasn't
  // touched the scroll. We track a programmatic "expected scrollTop"
  // so our own scrollIntoView calls don't look like user scrolls.
  // The follow window auto-tears down after 1.5s — by then async
  // content has settled and the user is in control.
  // Three pieces of state, each living past one effect run:
  //  - anchorAppliedRef: have we performed the initial scroll for this
  //    anchor yet? (Dedupes the scroll so newer/older page loads don't
  //    yank the user back.)
  //  - userHasScrolledRef: has the reader already moved the scroll
  //    themselves? Once true for this anchor, follow-anchor stays off
  //    for the remainder of the anchor's life — even across StrictMode
  //    cleanup/re-fire and across page-fetch effect re-runs.
  //  - followDeadlineRef: timestamp after which we stop following
  //    regardless. Survives StrictMode's cleanup/re-setup so the
  //    1.5s window is wall-clock, not per-mount.
  const anchorAppliedRef = useRef<string | null>(null);
  const followDeadlineRef = useRef<number>(0);
  useLayoutEffect(() => {
    if (!anchorMsgId) {
      anchorAppliedRef.current = null;
      userHasScrolledRef.current = false;
      followDeadlineRef.current = 0;
      return;
    }
    if (allMessages.length === 0) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const el = document.getElementById(`msg-${anchorMsgId}`);
    if (!el) return;

    // The dedup key combines the anchor with the per-navigation
    // revision. A re-click of the SAME search hit pushes a new
    // history entry with a fresh location.key, so anchorRevision
    // changes — that flips this key and re-fires the scroll +
    // highlight, matching user expectation that "click the result
    // again to jump back".
    const dedupKey = anchorRevision ? `${anchorMsgId}@${anchorRevision}` : anchorMsgId;
    if (anchorAppliedRef.current !== dedupKey) {
      el.scrollIntoView({ block: 'center' });
      anchorAppliedRef.current = dedupKey;
      wasAtBottomRef.current = false;
      userHasScrolledRef.current = false;
      followDeadlineRef.current = Date.now() + 1500;
    }

    // Skip follow-anchor setup if the user already took control or
    // the wall-clock window has already elapsed. Otherwise install
    // (or re-install, on StrictMode re-fire / page-fetch re-render)
    // the ResizeObserver + scroll listener that re-centers as avatars
    // / attachments load above the anchor.
    if (userHasScrolledRef.current) return;
    if (Date.now() >= followDeadlineRef.current) return;
    if (typeof ResizeObserver === 'undefined') return;
    const inner = innerRef.current;
    if (!inner) return;
    let expectedScrollTop = scroller.scrollTop;
    const stopFollowing = () => {
      ro.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      window.clearTimeout(timeoutId);
    };
    const onScroll = () => {
      // Real user scroll: scrollTop moved without us asking for it.
      // Our scrollIntoView calls update expectedScrollTop right
      // afterwards, so they don't trip this branch.
      if (Math.abs(scroller.scrollTop - expectedScrollTop) > 5) {
        userHasScrolledRef.current = true;
        stopFollowing();
      }
    };
    const ro = new ResizeObserver(() => {
      // Late-loading content above the anchor would otherwise push it
      // off the viewport. Re-center and refresh expectedScrollTop so
      // the scroll listener doesn't misread our write as a user scroll.
      el.scrollIntoView({ block: 'center' });
      expectedScrollTop = scroller.scrollTop;
    });
    ro.observe(inner);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const remaining = Math.max(0, followDeadlineRef.current - Date.now());
    const timeoutId = window.setTimeout(stopFollowing, remaining);
    return stopFollowing;
  }, [anchorMsgId, anchorRevision, allMessages.length, wasAtBottomRef]);

  // Cosmetic highlight ring on the anchor. Separate from the scroll
  // effect so it can run as a normal effect (with a setTimeout) and
  // so its dependency on `allMessages.length === 0` (a boolean) means
  // it fires once when messages first appear, not on every later page
  // fetch. anchorRevision is included so re-clicking the same hit
  // re-triggers the highlight flash.
  const messagesHaveLoaded = allMessages.length > 0;
  useEffect(() => {
    if (!anchorMsgId || !messagesHaveLoaded) return;
    const el = document.getElementById(`msg-${anchorMsgId}`);
    if (!el) return;
    el.classList.add(...ANCHOR_HIGHLIGHT_CLASSES);
    const t = window.setTimeout(() => {
      el.classList.remove(...ANCHOR_HIGHLIGHT_CLASSES);
    }, ANCHOR_HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(t);
      el.classList.remove(...ANCHOR_HIGHLIGHT_CLASSES);
    };
  }, [anchorMsgId, anchorRevision, messagesHaveLoaded]);

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
  useLayoutEffect(() => {
    const len = allMessages.length;
    const bottom = allMessages[len - 1];
    const bottomId = bottom?.id ?? null;
    const wasFirstRun = lastBottomIdRef.current === undefined;
    const prevBottomId = lastBottomIdRef.current;
    if (bottomId === prevBottomId) return;
    lastBottomIdRef.current = bottomId;
    if (wasFirstRun) return;
    // Skip when transitioning OUT OF an empty state. That's a query
    // refetch (parent change, anchor change) populating, NOT a fresh
    // send.
    if (prevBottomId === null) return;
    // Skip page loads. A fresh send appends exactly one message at
    // the end, so the previous bottom is now at index len-2. A
    // load-newer page-fetch shifts the previous bottom several
    // positions up. Without this guard, paging through newer messages
    // in deep-link mode gets yanked to the latest as soon as the new
    // page's bottom happens to be the user's own message.
    const secondToLast = len >= 2 ? allMessages[len - 2] : undefined;
    if (secondToLast?.id !== prevBottomId) return;
    if (!bottom || bottom.parentMessageID) return;
    if (bottom.authorID !== currentUserId) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    wasAtBottomRef.current = true;
  }, [allMessages, currentUserId, wasAtBottomRef]);

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

  // Read isFetching flags via refs inside the observer callbacks so the
  // observers don't get torn down and recreated on every fetch cycle.
  // observe() re-fires the initial intersection callback on each new
  // observer; with the sentinel sitting inside the 800px rootMargin,
  // that retrigger fires fetchPreviousPage twice in a row before pages
  // is updated, sending the same cursor to the server.
  const isFetchingNextRef = useLatestRef(isFetchingNextPage);
  const isFetchingPrevRef = useLatestRef(isFetchingPreviousPage);

  useEffect(() => {
    const node = loadMoreRef.current;
    const root = scrollRef.current;
    if (!node || !root || !hasNextPage) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isFetchingNextRef.current) {
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
  }, [hasNextPage, fetchNextPage, isFetchingNextRef]);

  // Newer-direction sentinel; only mounted while a deep-link window
  // is open. Pulls successive newer pages until the live tail is in
  // sight again.
  useEffect(() => {
    const node = loadNewerRef.current;
    const root = scrollRef.current;
    if (!node || !root || !hasPreviousPage || !fetchPreviousPage) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !isFetchingPrevRef.current) {
            fetchPreviousPage();
            return;
          }
        }
      },
      { root, rootMargin: '800px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasPreviousPage, fetchPreviousPage, isFetchingPrevRef]);

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
      <div ref={innerRef} className="p-4 space-y-1">
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
      {hasPreviousPage && (
        <div
          ref={loadNewerRef}
          data-testid="message-list-load-newer"
          className="flex h-8 items-center justify-center text-xs text-muted-foreground"
        >
          {isFetchingPreviousPage ? 'Loading newer messages…' : ''}
        </div>
      )}
    </div>
  );
}
