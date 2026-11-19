import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { MessageListRow } from './MessageListRows';

const ANCHOR_HIGHLIGHT_MS = 2200;
// How long, at most, the list keeps re-aiming at a linked message while its
// rows settle (counted in checks two frames apart), and how many checks in a
// row it must find the message in view, with the list no longer growing.
const ANCHOR_SETTLE_CHECKS = 40;
const ANCHOR_SETTLED_AFTER = 3;

// A chat opened at a linked message (a deep link, a notification): the list
// scrolls to it, flashes it, and holds the older-page fetch while the reader
// is still on it.
export function useMessageListAnchor({
  anchorMsgId,
  anchorRevision,
  rows,
  virtuosoRef,
  scrollerRef,
}: {
  anchorMsgId?: string;
  anchorRevision?: string;
  rows: MessageListRow[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  // Belt-and-braces vs initialTopMostItemIndex: data may arrive after
  // mount, so we re-scroll inside an effect once anchorIndex resolves.
  const anchorIndex = anchorMsgId
    ? rows.findIndex((r) => r.kind === 'message' && r.message.id === anchorMsgId)
    : -1;
  // React-driven (not classList.add on getElementById) because the
  // DOM element doesn't exist yet on first paint for off-viewport
  // anchors — the timeout would race virtuoso's render. The ring shows
  // until the flash for this anchor (message + revision) has run out.
  const anchorKey = anchorMsgId ? `${anchorMsgId}@${anchorRevision ?? ''}` : null;
  const [flashedKey, setFlashedKey] = useState<string | null>(null);
  const highlightedMessageId = anchorKey !== null && flashedKey !== anchorKey ? anchorMsgId! : null;
  const anchorAppliedRef = useRef<string | null>(null);
  // Held while the person hasn't scrolled since a link landed. Virtuoso asks
  // for an older page right away (the top of the small window is within its
  // overscan), and inserting it above the linked message shifts it by the
  // rows' estimated height (88px each; real rows are far shorter) — the view
  // drifted down, to the bottom in a short chat. So that page waits until the
  // person scrolls up (see onScroll); scrolling or jumping to the unread line
  // lets go.
  const anchorHeldRef = useRef(!!anchorMsgId);
  useLayoutEffect(() => {
    anchorHeldRef.current = !!anchorMsgId;
  }, [anchorMsgId, anchorRevision]);

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
    // Rows start at an estimated height and grow as they are measured (and as
    // fonts and pictures load), so one scrollToIndex can land anywhere: run
    // before the list has measured anything, it is a no-op, and the list then
    // grows with the message out of view (seen on a loaded phone). So aim,
    // then check every two frames and aim again while the message is out of
    // view, until it has stayed in view with the list no longer growing. The
    // person scrolling lets go of the message (anchorHeldRef), and so does the
    // check running out.
    let frame = 0;
    let checks = 0;
    let settled = 0;
    let lastHeight = -1;
    const later = (next: () => void) => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(next);
      });
    };
    const aim = () => {
      virtuosoRef.current?.scrollToIndex({ index: anchorIndex, align: 'center' });
      later(check);
    };
    const check = () => {
      checks += 1;
      const scroller = scrollerRef.current;
      // Nothing to check against: the one aim stands (never a blind chase).
      if (!scroller) return;
      const row = scroller.querySelector(`[data-message-id="${CSS.escape(anchorMsgId)}"]`);
      const view = scroller.getBoundingClientRect();
      const box = row?.getBoundingClientRect();
      const inView = !!box && box.height > 0 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
      const height = scroller.scrollHeight;
      settled = inView && height === lastHeight ? settled + 1 : 0;
      lastHeight = height;
      if (settled >= ANCHOR_SETTLED_AFTER || checks >= ANCHOR_SETTLE_CHECKS || !anchorHeldRef.current) return;
      if (inView) later(check);
      else aim();
    };
    frame = requestAnimationFrame(() => {
      // Record "applied" only AFTER the scroll actually runs. On a cold
      // deeplink / notification open the `around` window mounts with the
      // anchor present, but Virtuoso's natural startReached prepends an
      // older page moments later — shifting anchorIndex and re-running this
      // effect. The cleanup cancels this frame before it fires; recording
      // the dedup up-front (the old bug) then made the re-run bail, so the
      // scroll was lost and the deeplink landed nowhere until a manual
      // retry. Recording here instead lets the re-run re-schedule at the
      // corrected index, while still settling exactly one anchor at a time
      // (the cleanup cancels whatever frame is pending).
      anchorAppliedRef.current = dedupKey;
      aim();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorMsgId, anchorRevision, anchorIndex, virtuosoRef, scrollerRef]);

  // Deep-link flash highlight. Keyed on the anchor IDENTITY (anchorMsgId +
  // anchorRevision), never anchorIndex. This is load-bearing: when it lived in
  // the scroll effect above, a page prepend that shifted anchorIndex re-ran the
  // effect, whose cleanup cancelled the pending clear timer while the dedup
  // early-return skipped re-arming it — so the ring stuck forever (the "never
  // de-highlights" regression). Tying the timer to the anchor identity means an
  // index shift can't tear it down: the ring shows once per anchor and clears
  // after the flash window. cleanup guarantees only the current anchor's timer
  // is ever live.
  useEffect(() => {
    if (anchorKey === null) return;
    const flashId = window.setTimeout(() => setFlashedKey(anchorKey), ANCHOR_HIGHLIGHT_MS);
    return () => window.clearTimeout(flashId);
  }, [anchorKey]);

  return { anchorIndex, highlightedMessageId, anchorHeldRef };
}
