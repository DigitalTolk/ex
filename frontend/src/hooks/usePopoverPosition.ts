import { useEffect, useRef, useState, type RefObject } from 'react';

export interface PopoverPosition {
  // Vertical placement: 'bottom' renders below the trigger; 'top' renders above
  // when there isn't enough room below the viewport.
  side: 'top' | 'bottom';
  // Horizontal placement: 'start' aligns left edges; 'end' aligns right edges.
  align: 'start' | 'end';
  // Viewport-fixed coordinates clamped inside the visible area. Apply with
  // `position: fixed` on a portal'd container so the popover escapes any
  // overflow:hidden ancestor and any z-index stacking context.
  top: number;
  left: number;
}

interface Options {
  // Estimate of popover dimensions in px so we can pre-place it before measuring.
  estimatedHeight?: number;
  estimatedWidth?: number;
  // Default placement before adjusting.
  preferredSide?: 'top' | 'bottom';
  preferredAlign?: 'start' | 'end';
  // Margin from viewport edges before flipping or clamping.
  margin?: number;
  // Optional element ref measured for accurate width/height; if not yet
  // rendered (first paint) the estimated dimensions are used.
  contentRef?: RefObject<HTMLElement | null>;
}

/**
 * Returns viewport-fixed coordinates and a side/align placement that keeps a
 * popover anchored to triggerRef inside the viewport. Recomputes on `open`
 * toggle, on resize, and on scroll (capture). Use the coordinates with
 * `position: fixed` and render the content via a portal to `document.body`
 * so the popover is not clipped by overflow:hidden ancestors and is not
 * trapped under a fixed-position sidebar's stacking context.
 */
export function usePopoverPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  opts: Options = {},
): PopoverPosition {
  const {
    estimatedHeight = 280,
    estimatedWidth = 288,
    preferredSide = 'bottom',
    preferredAlign = 'start',
    margin = 8,
    contentRef,
  } = opts;
  const [pos, setPos] = useState<PopoverPosition>({
    side: preferredSide,
    align: preferredAlign,
    top: 0,
    left: 0,
  });
  const rafRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    function compute() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;

      const measured = contentRef?.current?.getBoundingClientRect();
      const height = measured && measured.height > 0 ? measured.height : estimatedHeight;
      const width = measured && measured.width > 0 ? measured.width : estimatedWidth;

      const spaceBelow = vh - rect.bottom;
      const spaceAbove = rect.top;
      let side: 'top' | 'bottom' = preferredSide;
      if (preferredSide === 'bottom' && spaceBelow < height + margin && spaceAbove > spaceBelow) {
        side = 'top';
      } else if (preferredSide === 'top' && spaceAbove < height + margin && spaceBelow > spaceAbove) {
        side = 'bottom';
      }

      let align: 'start' | 'end' = preferredAlign;
      if (preferredAlign === 'start') {
        if (rect.left + width + margin > vw) align = 'end';
      } else {
        if (rect.right - width - margin < 0) align = 'start';
      }

      // Compute viewport-fixed coordinates, then clamp inside the visible
      // area so the popover never renders off-screen even on tiny viewports.
      let top = side === 'bottom' ? rect.bottom + 4 : rect.top - height - 4;
      let left = align === 'start' ? rect.left : rect.right - width;
      if (top + height + margin > vh) top = Math.max(margin, vh - height - margin);
      if (top < margin) top = margin;
      if (left + width + margin > vw) left = Math.max(margin, vw - width - margin);
      if (left < margin) left = margin;

      // Same-shape fast-path so React skips the re-render when nothing
      // changed; otherwise every scroll tick triggers a popover repaint.
      setPos((prev) =>
        prev.side === side &&
        prev.align === align &&
        Math.round(prev.top) === Math.round(top) &&
        Math.round(prev.left) === Math.round(left)
          ? prev
          : { side, align, top, left },
      );
    }
    function schedule() {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(compute);
    }
    compute();
    // Re-measure on next frame too: once the popover paints, contentRef has
    // real dimensions, so the second pass swaps the estimate for the truth.
    rafRef.current = requestAnimationFrame(compute);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [open, triggerRef, estimatedHeight, estimatedWidth, preferredSide, preferredAlign, margin, contentRef]);

  return pos;
}
