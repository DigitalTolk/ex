import { useLayoutEffect, useRef, useState } from 'react';
import { animate, useMotionValue } from 'motion/react';
import { useIsMobile } from './useIsMobile';
import { useAxisSwipe, type AxisSwipeRelease } from './useAxisSwipe';
import { SWIPE_SPRING, SWIPE_SURFACE_ATTR, shouldCommitSwipe, swipeStartsOn } from '@/lib/swipe';

// A panel dismissed by a swipe on mobile: the right-hand panels (thread,
// members, pinned…) go right, the bottom sheets go down. The panel follows
// the finger (useAxisSwipe, on @use-gesture/react); a release that goes
// through (lib/swipe) carries on off-screen with the finger's speed and then
// calls onDismiss, anything else springs back. The same Motion value drives
// the mobile slide-in, so enter, drag and dismiss share one transform.
//
// A sheet's content scrolls on the same axis as its dismiss, so a sheet
// swipe only starts where a vertical drag can mean nothing else (see
// shouldStartDismissDrag); a side panel's vertical scrolling and its
// sideways dismiss never compete for an axis.

function offscreen(horizontal: boolean) {
  /* v8 ignore next -- SSR guard; this browser-only app always has window */
  /* istanbul ignore next -- SSR guard; this browser-only app always has window */
  if (typeof window === 'undefined') return horizontal ? 600 : 800;
  return horizontal ? window.innerWidth : window.innerHeight;
}

// Attribute marking a surface whose vertical drag means "dismiss this sheet"
// and nothing else — the grab handle, and chrome strips (category tabs, the
// skin-tone row) that already opt out of native panning with touch-action:none.
export const SHEET_DRAG_ATTR = 'data-sheet-drag';

function hasRoomToScroll(el: Element) {
  return el.scrollHeight > el.clientHeight + 1;
}

// Whether a pointerdown inside the sheet should arm the dismiss drag.
//
// Erring PERMISSIVE here is what made the emoji and GIF pickers feel frozen on
// a phone. The sheet only moves down, so once its drag claims a touch an
// UPWARD swipe goes nowhere: the sheet merely stretches, and the list
// underneath doesn't scroll. A finger dragged up over the "Frequently used"
// shelf or the category strip went into a black hole, which reads exactly as
// "I can't scroll this popup".
//
// So the default is now to DECLINE. Only two surfaces claim a vertical drag:
// explicit drag chrome, and a scroll body with nothing left to scroll.
function shouldStartDismissDrag(target: Element, root: Element): boolean {
  if (target.closest(`[${SHEET_DRAG_ATTR}="true"]`)) return true;
  const scroller = target.closest<HTMLElement>('[data-swipe-scroll="true"]');
  // A scroller WITH ROOM TO SCROLL never starts the dismiss drag — not even at
  // scrollTop 0. A sheet always opens at the top, so gating on scrollTop meant
  // Motion captured the very first vertical touch and the body could never
  // START scrolling.
  if (scroller) return !hasRoomToScroll(scroller);
  // Unmarked chrome (a search field, a section label, a shelf). Claim the
  // gesture only when there is nothing anywhere in this sheet that a drag
  // could have been meant to scroll — otherwise assume the user was reaching
  // for the list and leave the gesture to the browser.
  return !Array.from(root.querySelectorAll('[data-swipe-scroll="true"]')).some(hasRoomToScroll);
}

// `open` should be passed by callers whose host component STAYS MOUNTED while
// the panel is toggled (e.g. a message's action sheet on an always-mounted
// MessageItem). It re-initialises the gesture on each open. Callers whose panel
// unmounts when closed can omit it (defaults true → the mount is the open).
export function useSwipeDismiss(direction: 'right' | 'down', onDismiss: () => void, open = true) {
  const isMobile = useIsMobile();
  const horizontal = direction === 'right';
  const offset = useMotionValue(0);
  const [dismissing, setDismissing] = useState(false);
  // Whether the live transform is currently displaced from its resting
  // position. Starts true on mobile (the panel mounts off-screen and
  // slides in) so the right-rail panels carry a left border while moving,
  // and is driven thereafter by the motion value: any drag/enter/exit
  // displaces it, resting at ≈0 clears it.
  const [displaced, setDisplaced] = useState(true);
  const dismissingRef = useRef(false);

  // Mobile enter: start off-screen and spring in. useLayoutEffect runs
  // before paint so the panel is positioned off-screen on first frame —
  // no flash at the resting position. Re-runs on each `open`: this is the
  // reopen fix. `offset` (a motion value) and the dismiss latch persist across
  // opens when the host component doesn't unmount, so a swiped-away sheet left
  // `offset` off-screen and `dismissingRef` armed — reopening rendered it
  // translated off-screen ("won't pop up"). Resetting both here makes every
  // open a fresh slide-in.
  useLayoutEffect(() => {
    if (!isMobile || !open) return;
    // Ref write (not setState) — lint-safe in an effect. Clears the drag latch
    // so a reopened panel is draggable again even if the exit animation's
    // onComplete didn't run (interrupted dismiss).
    dismissingRef.current = false;
    offset.set(offscreen(horizontal));
    const controls = animate(offset, 0, SWIPE_SPRING);
    return () => controls.stop();
  }, [isMobile, horizontal, offset, open]);

  // Track displacement off the live transform. Only the horizontal
  // (right-rail) panels consume `settled` for their mobile border, so we
  // subscribe only there — the vertical bottom-sheets don't pay for an
  // extra re-render when the enter spring settles. Updates flow solely
  // through the motion value's change events (never a synchronous setState
  // in the effect body), so there are no cascading renders.
  useLayoutEffect(() => {
    if (!isMobile || !horizontal) return;
    return offset.on('change', (v) => {
      const away = Math.abs(v) >= 0.5;
      setDisplaced((prev) => (prev === away ? prev : away));
    });
  }, [isMobile, horizontal, offset]);

  // Settled everywhere except a horizontal panel mid-motion on mobile.
  const settled = !isMobile || !horizontal || !displaced;

  const onRelease = ({ value, velocity, aborted }: AxisSwipeRelease) => {
    if (dismissingRef.current) return;
    const travel = offscreen(horizontal);
    if (aborted || !shouldCommitSwipe({ distance: value, velocity, travel })) {
      animate(offset, 0, { ...SWIPE_SPRING, velocity });
      return;
    }
    dismissingRef.current = true;
    setDismissing(true);
    animate(offset, travel, {
      ...SWIPE_SPRING,
      velocity,
      // Clear the latch when the exit finishes (a callback, so setState is
      // lint-safe here) so a reopen on the same mounted host starts clean.
      onComplete: () => {
        dismissingRef.current = false;
        setDismissing(false);
        onDismiss();
      },
    });
  };

  const swipe = useAxisSwipe({
    enabled: isMobile,
    axis: horizontal ? 'x' : 'y',
    value: offset,
    range: () => [0, offscreen(horizontal)],
    canStart: horizontal
      ? swipeStartsOn
      : // swipeStartsOn only passes a touch on an element inside the sheet.
        (target, surface) => swipeStartsOn(target, surface) && shouldStartDismissDrag(target as Element, surface),
    onRelease,
  });

  if (!isMobile) {
    return { dismissing: false, settled: true, motionProps: {} as Record<string, never> };
  }

  return {
    dismissing,
    settled,
    motionProps: {
      [SWIPE_SURFACE_ATTR]: horizontal ? 'x' : 'y',
      // A side panel's touch-action comes with its surface (index.css). A
      // sheet stays pan-y so its body scrolls natively; its drag starts from
      // chrome that is touch-action: none itself.
      style: horizontal ? { x: offset } : { y: offset, touchAction: 'pan-y' as const },
      ...swipe,
    },
  };
}
