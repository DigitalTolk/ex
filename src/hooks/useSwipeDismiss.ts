import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { animate, useDragControls, useMotionValue, type PanInfo } from 'motion/react';
import { useIsMobile } from './useIsMobile';

// Motion-powered replacement for the old react-swipeable based
// useAnimatedSwipeDismiss. A panel becomes draggable along a single axis
// (right for side panels, down for bottom sheets); releasing past a
// distance/velocity threshold animates it off-screen and fires onDismiss,
// otherwise it springs back. The same Motion value also drives the
// mobile enter slide-in, so enter + drag + dismiss all animate through
// one transform — no CSS keyframes or AnimatePresence wiring needed.
//
// Inner scroll is preserved: the vertical ("down") variant never lets Motion
// own the pointerdown (dragListener: false). Instead the drag is started
// imperatively (useDragControls) only from surfaces where a vertical drag can
// mean nothing else (see shouldStartDismissDrag), so scrolling a long sheet is
// native from the very first gesture. This matters twice over: Motion's own drag listener applies a
// touch-action override (pan-x for drag:"y") that WebKit honors for the
// whole subtree — freezing descendant scrollers — and an armed-then-disarm
// React state round-trip always lost the gesture that was already latched.
// The horizontal ("right") variant doesn't conflict with vertical scrolling,
// so it keeps Motion's own listener (whose pan-y override is exactly right
// there: it blocks stray horizontal native pans of code blocks/tables while
// a panel drag is possible).

export const SWIPE_DISMISS_SPRING = { type: 'spring' as const, stiffness: 600, damping: 45 };
const DISMISS_DISTANCE = 72;
const DISMISS_VELOCITY = 400;

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
// a phone. The drag is pinned in the up direction (dragConstraints top:0 +
// dragElastic top:0), so once Motion claims a gesture an UPWARD swipe moves
// nothing at all: not the sheet, and — because the browser has handed the
// gesture to JS — not the list underneath it either. A finger dragged up over
// the "Frequently used" shelf or the category strip went into a black hole,
// which reads exactly as "I can't scroll this popup".
//
// So the default is now to DECLINE. Only two surfaces claim a vertical drag:
// explicit drag chrome, and a scroll body with nothing left to scroll.
function shouldStartDismissDrag(target: EventTarget | null, root: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
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
  if (!(root instanceof Element)) return true;
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
  const dragControls = useDragControls();
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
    const controls = animate(offset, 0, SWIPE_DISMISS_SPRING);
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

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Started imperatively so there is no state round-trip that loses the
      // already-latched gesture.
      if (shouldStartDismissDrag(e.target, e.currentTarget)) dragControls.start(e);
    },
    [dragControls],
  );

  const onDragEnd = useCallback(
    (_: PointerEvent, info: PanInfo) => {
      if (dismissingRef.current) return;
      const dist = horizontal ? info.offset.x : info.offset.y;
      const vel = horizontal ? info.velocity.x : info.velocity.y;
      if (dist > DISMISS_DISTANCE || vel > DISMISS_VELOCITY) {
        dismissingRef.current = true;
        setDismissing(true);
        animate(offset, offscreen(horizontal), {
          ...SWIPE_DISMISS_SPRING,
          // Clear the latch when the exit finishes (a callback, so setState is
          // lint-safe here) so a reopen on the same mounted host starts clean.
          onComplete: () => {
            dismissingRef.current = false;
            setDismissing(false);
            onDismiss();
          },
        });
      } else {
        animate(offset, 0, SWIPE_DISMISS_SPRING);
      }
    },
    [horizontal, offset, onDismiss],
  );

  if (!isMobile) {
    return { dismissing: false, settled: true, motionProps: {} as Record<string, never> };
  }

  return {
    dismissing,
    settled,
    motionProps: horizontal
      ? {
          drag: 'x' as const,
          dragDirectionLock: true,
          dragConstraints: { left: 0, right: 0 },
          // Follow the finger past the constraint only in the dismiss
          // direction; the opposite direction stays pinned.
          dragElastic: { left: 0, right: 1 },
          style: { x: offset },
          onDragEnd,
        }
      : {
          drag: 'y' as const,
          // Motion must NOT own the pointerdown (see header comment): its
          // listener would apply the pan-x touch-action override that blocks
          // descendant scrollers on WebKit and capture the gesture before
          // scroll-intent is known. onPointerDown starts the drag from
          // chrome touches only.
          dragControls,
          dragListener: false,
          dragDirectionLock: true,
          dragConstraints: { top: 0, bottom: 0 },
          dragElastic: { top: 0, bottom: 1 },
          // pan-y so the sheet's subtree stays natively pannable — with
          // dragListener off Motion no longer forces pan-x here.
          style: { y: offset, touchAction: 'pan-y' as const },
          onPointerDown,
          onDragEnd,
        },
  };
}
