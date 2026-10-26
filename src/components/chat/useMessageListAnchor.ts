import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { MessageListRow } from './MessageListRows';

const ANCHOR_HIGHLIGHT_MS = 2200;

// A chat opened at a linked message (a deep link, a notification): the list
// scrolls to it, flashes it, and holds the older-page fetch while the reader
// is still on it.
export function useMessageListAnchor({
  anchorMsgId,
  anchorRevision,
  rows,
  virtuosoRef,
}: {
  anchorMsgId?: string;
  anchorRevision?: string;
  rows: MessageListRow[];
  virtuosoRef: RefObject<VirtuosoHandle | null>;
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
  }, [anchorMsgId, anchorRevision, anchorIndex, virtuosoRef]);

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
