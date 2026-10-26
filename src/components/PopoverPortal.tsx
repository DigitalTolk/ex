import { useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverPosition } from '@/hooks/usePopoverPosition';
import { useIsMobile } from '@/hooks/useIsMobile';
import { usePointerDevice } from '@/hooks/usePointerDevice';
import { deviceKind } from '@/lib/device';
import { useTransientOverlayCleanup } from '@/hooks/useTransientOverlayCleanup';
import { motion } from 'motion/react';
import { useSwipeDismiss } from '@/hooks/useSwipeDismiss';
import { useMobileBackClose } from '@/hooks/useMobileBackClose';
import { KEYBOARD_SETTLE_MS, useKeyboardInset } from '@/hooks/useKeyboardInset';

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
  const keyboardInset = useKeyboardInset();
  const pointerDevice = usePointerDevice();
  // Sheet wherever touch is the only pointer — phones AND a tablet running the
  // desktop layout. Anchoring to a trigger assumes a trigger that is still on
  // screen and a pointer that can reach a popover next to it: the message
  // action sheet HIDES its trigger while the picker opens (a zero-size rect
  // pins the popover to the top-left corner), and a thumb is nowhere near it.
  // With a mouse/trackpad the anchored popover is the better fit again.
  const renderSheet = mobileSheet && (isMobile || (deviceKind() === 'touch' && !pointerDevice));
  // `open`, not the default: hosts keep this portal mounted while closed (a
  // user card in every message row), so the sheet's slide-in must arm on each
  // open. Armed at mount it was spent before the first open, a swiped-away
  // sheet reopened parked off-screen, and every closed row popover ran its
  // own spring whenever a chat opened.
  const { dismissing, motionProps } = useSwipeDismiss('down', () => {
    // The drag handlers are only attached in sheet mode, so this callback
    // only fires when renderSheet is true; the false arm and the
    // onDismiss?.-undefined arm are defensive.
    /* istanbul ignore next -- swipe-dismiss only fires in sheet mode with a provided onDismiss */
    if (renderSheet) onDismiss?.();
  }, open && renderSheet);
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
      // A menu opened from a control inside the popover is portaled beside
      // it, not into it: a press on one of its items is still "inside".
      if (target instanceof Element && target.closest('[role="menu"]')) return;
      onDismiss?.();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // The popover is on top: the key is its (a panel under it stays open).
      e.preventDefault();
      onDismiss?.();
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
              // On the on-screen keyboard, not under it: a picker's search
              // field raises the keyboard, and the results must stay in
              // sight above it. The app undoes iOS's own pan for the keyboard
              // (hooks/useKeyboardInset), so nothing else lifts the sheet.
              bottom: keyboardInset,
              transition: `bottom ${KEYBOARD_SETTLE_MS}ms var(--ex-keyboard-ease)`,
              zIndex: 1000,
              // Full width on a phone; on a tablet capped and centred so it
              // matches the message action sheet instead of spanning 1024px+.
              width: '100%',
              maxWidth: 'min(100vw, 32rem)',
              marginInline: 'auto',
              maxHeight: keyboardInset > 0
                ? `min(50dvh, calc(100dvh - ${keyboardInset}px - env(safe-area-inset-top, 0px)))`
                : '50dvh',
              // The home indicator's inset, which the sheet's content pads
              // for; iOS keeps reporting it while the keyboard covers it.
              ['--sheet-safe-bottom' as string]: keyboardInset > 0 ? '0px' : 'env(safe-area-inset-bottom, 0px)',
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
        {renderSheet && (
          <div
            className="flex shrink-0 items-center justify-center pb-2 pt-2"
            // The grab handle is the guaranteed swipe-to-dismiss surface:
            // touch-action none here keeps the browser from claiming the
            // gesture as a (no-op) native scroll and pointer-cancelling the
            // drag. Everywhere else the sheet stays pan-y so scroll bodies
            // (e.g. the emoji grid) pan natively from the very first touch.
            style={{ touchAction: 'none' }}
            aria-hidden="true"
            data-sheet-drag="true"
            data-testid="sheet-grab-handle"
          >
            <div className="h-1 w-9 rounded-full bg-border-strong" />
          </div>
        )}
        {children}
      </motion.div>
    </>,
    document.body,
  );
}
