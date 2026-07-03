import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverPosition } from '@/hooks/usePopoverPosition';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useTransientOverlayCleanup } from '@/hooks/useTransientOverlayCleanup';
import { motion } from 'motion/react';
import { useSwipeDismiss } from '@/hooks/useSwipeDismiss';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';

interface PopoverPortalProps {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  onDismiss?: () => void;
  // Click outside *both* the trigger and the popover dismisses; pass the
  // trigger element so we don't immediately close on the very click that
  // opened the popover.
  estimatedHeight?: number;
  estimatedWidth?: number;
  preferredSide?: 'top' | 'bottom';
  preferredAlign?: 'start' | 'end';
  className?: string;
  role?: string;
  ariaLabel?: string;
  mobileSheet?: boolean;
  children: ReactNode;
}

/**
 * Renders popover content into a portal at document.body using
 * `position: fixed` with viewport-clamped coordinates. This bypasses any
 * overflow:hidden or stacking-context ancestor so the popover is never
 * clipped by a sidebar, dialog, or scroll container. Dismissal on outside
 * click and Escape is handled centrally.
 */
export function PopoverPortal({
  open,
  triggerRef,
  onDismiss,
  estimatedHeight,
  estimatedWidth,
  preferredSide = 'bottom',
  preferredAlign = 'start',
  className = '',
  role = 'dialog',
  ariaLabel,
  mobileSheet = false,
  children,
}: PopoverPortalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const renderSheet = mobileSheet && isMobile;
  const { dismissing, motionProps } = useSwipeDismiss('down', () => {
    // The drag handlers are only attached in sheet mode, so this callback
    // only fires when renderSheet is true; the false arm and the
    // onDismiss?.-undefined arm are defensive.
    /* istanbul ignore next -- swipe-dismiss only fires in sheet mode with a provided onDismiss */
    if (renderSheet) onDismiss?.();
  });
  // Motion drag (style + handlers) is only applied in mobile-sheet mode.
  const { style: sheetDragStyle, ...sheetDragHandlers } = (renderSheet ? motionProps : {}) as {
    style?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const setContentRef = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
  }, []);
  // Back on mobile dismisses the open popover/sheet instead of navigating.
  useMobileBackClose(open, onDismiss);
  const pos = usePopoverPosition(open, triggerRef, {
    estimatedHeight,
    estimatedWidth,
    preferredSide,
    preferredAlign,
    contentRef,
  });

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      const target = e.target as Node | null;
      /* istanbul ignore next -- a dispatched pointerdown always carries a target Node; defensive null guard */
      if (!target) return;
      /* istanbul ignore next -- the popover is rendered (open) whenever this listener is active, so contentRef.current is non-null; the ?.-null arm is defensive */
      if (contentRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onDismiss?.();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss?.();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onDismiss, triggerRef]);

  useTransientOverlayCleanup(open, { rootRef: contentRef });

  if (!open || typeof document === 'undefined') return null;

  const measured = renderSheet ? true : pos.measured;
  return createPortal(
    <>
      {renderSheet && (
        <div
          className="fixed inset-0 z-[999] bg-black/35"
          aria-hidden="true"
          onPointerDown={onDismiss}
        />
      )}
      <motion.div
        ref={setContentRef}
        role={role}
        aria-label={ariaLabel}
        data-testid="popover-portal"
        data-popover-side={renderSheet ? 'bottom' : pos.side}
        data-popover-align={renderSheet ? 'start' : pos.align}
        data-popover-measured={measured ? 'true' : 'false'}
        data-mobile-sheet={renderSheet ? 'true' : 'false'}
        // Hide until measured — seeded (0,0) would otherwise flash in the
        // top-left corner before the position effect commits. In sheet mode
        // Motion drives the enter slide + drag-to-dismiss via the y transform.
        style={renderSheet
          ? {
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 1000,
              width: '100vw',
              maxWidth: '100vw',
              maxHeight: '50dvh',
              overflow: 'hidden',
              overscrollBehaviorY: 'contain',
              touchAction: 'pan-y',
              opacity: 1,
              pointerEvents: 'auto',
              ...sheetDragStyle,
            }
          : {
              position: 'fixed',
              top: pos.top,
              left: pos.left,
              zIndex: 1000,
              maxWidth: 'calc(100vw - 16px)',
              maxHeight: 'calc(100dvh - 16px)',
              overflowY: 'auto',
              opacity: measured ? 1 : 0,
              pointerEvents: measured ? 'auto' : 'none',
            }}
        className={className}
        data-swipe-dismissing={String(dismissing)}
        {...sheetDragHandlers}
      >
        {children}
      </motion.div>
    </>,
    document.body,
  );
}
