import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverPosition } from '@/hooks/usePopoverPosition';

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
  children,
}: PopoverPortalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(open, triggerRef, {
    estimatedHeight,
    estimatedWidth,
    preferredSide,
    preferredAlign,
    contentRef,
  });

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (contentRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onDismiss?.();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onDismiss?.();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onDismiss, triggerRef]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={contentRef}
      role={role}
      aria-label={ariaLabel}
      data-testid="popover-portal"
      data-popover-side={pos.side}
      data-popover-align={pos.align}
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000 }}
      className={className}
    >
      {children}
    </div>,
    document.body,
  );
}
