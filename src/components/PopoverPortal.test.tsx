import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PopoverPortal } from './PopoverPortal';

let mockIsMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mockIsMobile }));
vi.mock('@/hooks/usePopoverPosition', () => ({
  usePopoverPosition: () => ({ side: 'bottom', align: 'start', top: 10, left: 10, measured: true }),
}));
vi.mock('@/hooks/useTransientOverlayCleanup', () => ({
  useTransientOverlayCleanup: () => {},
}));
// Capture the swipe-down dismiss callback so a test can fire it directly.
let capturedSwipeDismiss: (() => void) | undefined;
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: (_dir: string, onDismiss: () => void) => {
    capturedSwipeDismiss = onDismiss;
    return { dismissing: false, motionProps: {} };
  },
}));

function renderPortal(onDismiss = vi.fn(), props: { mobileSheet?: boolean } = {}) {
  const triggerRef = { current: document.createElement('button') };
  document.body.appendChild(triggerRef.current);
  render(
    <PopoverPortal open triggerRef={triggerRef} onDismiss={onDismiss} {...props}>
      <div data-testid="popover-content">content</div>
    </PopoverPortal>,
  );
  return { onDismiss, trigger: triggerRef.current };
}

describe('PopoverPortal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mockIsMobile = false;
    capturedSwipeDismiss = undefined;
  });

  it('renders its children into a portal', () => {
    renderPortal();
    expect(screen.getByTestId('popover-content')).toBeInTheDocument();
  });

  it('dismisses on a pointerdown outside the content and trigger', () => {
    const { onDismiss } = renderPortal();
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    fireEvent.pointerDown(outside);
    expect(onDismiss).toHaveBeenCalled();
  });

  it('does not dismiss on a pointerdown inside the content', () => {
    const { onDismiss } = renderPortal();
    fireEvent.pointerDown(screen.getByTestId('popover-content'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not dismiss on a pointerdown on the trigger', () => {
    const { onDismiss, trigger } = renderPortal();
    fireEvent.pointerDown(trigger);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('renders as a bottom sheet with a backdrop on mobile when mobileSheet is set', () => {
    mockIsMobile = true;
    const { onDismiss } = renderPortal(vi.fn(), { mobileSheet: true });
    const portal = screen.getByTestId('popover-portal');
    expect(portal).toHaveAttribute('data-mobile-sheet', 'true');
    // Sheet mode forces measured=true, so opacity/pointerEvents resolve to the
    // visible branch.
    expect(portal).toHaveStyle({ opacity: '1', pointerEvents: 'auto' });
    // The backdrop dismisses on pointerdown.
    const backdrop = document.querySelector('[aria-hidden="true"]')!;
    fireEvent.pointerDown(backdrop);
    expect(onDismiss).toHaveBeenCalled();
  });

  it('invokes onDismiss from the swipe-down gesture only in sheet mode', () => {
    mockIsMobile = true;
    const { onDismiss } = renderPortal(vi.fn(), { mobileSheet: true });
    // Fire the captured swipe-down dismiss callback → renderSheet is true.
    capturedSwipeDismiss?.();
    expect(onDismiss).toHaveBeenCalled();
  });

  it('ignores the swipe-down gesture when not rendering as a sheet', () => {
    // Desktop (not mobile) → renderSheet false → the swipe callback is a no-op.
    const { onDismiss } = renderPortal(vi.fn(), { mobileSheet: true });
    capturedSwipeDismiss?.();
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
