import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useRef } from 'react';
import { PopoverPortal } from '@/components/PopoverPortal';

function Harness({
  open,
  onDismiss,
  triggerRect,
  preferredAlign,
  preferredSide,
  estimatedHeight = 100,
  estimatedWidth = 100,
}: {
  open: boolean;
  onDismiss?: () => void;
  triggerRect: { top: number; bottom: number; left: number; right: number };
  preferredAlign?: 'start' | 'end';
  preferredSide?: 'top' | 'bottom';
  estimatedHeight?: number;
  estimatedWidth?: number;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  function setTriggerRef(el: HTMLSpanElement | null) {
    triggerRef.current = el;
    if (el) {
      el.getBoundingClientRect = () =>
        ({
          top: triggerRect.top,
          bottom: triggerRect.bottom,
          left: triggerRect.left,
          right: triggerRect.right,
          width: triggerRect.right - triggerRect.left,
          height: triggerRect.bottom - triggerRect.top,
          x: triggerRect.left,
          y: triggerRect.top,
          toJSON: () => ({}),
        }) as DOMRect;
    }
  }
  return (
    <div>
      <span ref={setTriggerRef} data-testid="trigger">
        trigger
      </span>
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={onDismiss}
        estimatedHeight={estimatedHeight}
        estimatedWidth={estimatedWidth}
        preferredAlign={preferredAlign}
        preferredSide={preferredSide}
      >
        <div>popover content</div>
      </PopoverPortal>
    </div>
  );
}

describe('PopoverPortal', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 800, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, configurable: true });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when open=false', () => {
    render(
      <Harness
        open={false}
        triggerRect={{ top: 100, bottom: 120, left: 100, right: 200 }}
      />,
    );
    expect(screen.queryByTestId('popover-portal')).toBeNull();
  });

  it('renders content into a portal at document.body when open=true', () => {
    render(
      <Harness
        open
        triggerRect={{ top: 100, bottom: 120, left: 100, right: 200 }}
      />,
    );
    const portal = screen.getByTestId('popover-portal');
    expect(portal).not.toBeNull();
    expect(portal.parentElement).toBe(document.body);
    expect(portal.style.position).toBe('fixed');
  });

  it('clamps coordinates inside the viewport when trigger is near right edge', () => {
    render(
      <Harness
        open
        preferredAlign="start"
        estimatedWidth={400}
        estimatedHeight={100}
        triggerRect={{ top: 100, bottom: 120, left: 700, right: 780 }}
      />,
    );
    const portal = screen.getByTestId('popover-portal');
    const left = parseFloat(portal.style.left);
    expect(left + 400).toBeLessThanOrEqual(800);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('flips above when not enough room below', () => {
    render(
      <Harness
        open
        preferredSide="bottom"
        estimatedHeight={400}
        triggerRect={{ top: 500, bottom: 540, left: 100, right: 200 }}
      />,
    );
    const portal = screen.getByTestId('popover-portal');
    expect(portal.getAttribute('data-popover-side')).toBe('top');
  });

  it('clamps top so popover never renders below the viewport', () => {
    render(
      <Harness
        open
        preferredSide="bottom"
        estimatedHeight={300}
        triggerRect={{ top: 580, bottom: 595, left: 100, right: 200 }}
      />,
    );
    const portal = screen.getByTestId('popover-portal');
    const top = parseFloat(portal.style.top);
    expect(top + 300).toBeLessThanOrEqual(600);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('uses a high z-index so it sits above sidebars', () => {
    render(
      <Harness
        open
        triggerRect={{ top: 100, bottom: 120, left: 100, right: 200 }}
      />,
    );
    const portal = screen.getByTestId('popover-portal');
    expect(parseInt(portal.style.zIndex, 10)).toBeGreaterThanOrEqual(50);
  });

  it('calls onDismiss on Escape', () => {
    const onDismiss = vi.fn();
    render(
      <Harness
        open
        onDismiss={onDismiss}
        triggerRect={{ top: 100, bottom: 120, left: 100, right: 200 }}
      />,
    );
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('calls onDismiss when clicking outside both trigger and content', () => {
    const onDismiss = vi.fn();
    render(
      <div>
        <Harness
          open
          onDismiss={onDismiss}
          triggerRect={{ top: 100, bottom: 120, left: 100, right: 200 }}
        />
        <button data-testid="outside">outside</button>
      </div>,
    );
    act(() => {
      fireEvent.mouseDown(screen.getByTestId('outside'));
    });
    expect(onDismiss).toHaveBeenCalled();
  });

  it('flips data-popover-measured to "true" only after compute() runs (no top-left flash)', () => {
    // The bug: the popover briefly rendered at (0,0) — the seeded
    // initial state — before the position effect committed. The fix
    // hides it via opacity-0 until pos.measured flips true. After the
    // synchronous compute() in usePopoverPosition's effect, the
    // attribute is "true" and the inline style has opacity:1.
    render(
      <Harness
        open
        triggerRect={{ top: 100, bottom: 120, left: 100, right: 200 }}
      />,
    );
    const portal = screen.getByTestId('popover-portal');
    expect(portal.getAttribute('data-popover-measured')).toBe('true');
    expect(portal.style.opacity).toBe('1');
  });

  it('does not call onDismiss when clicking inside the popover', () => {
    const onDismiss = vi.fn();
    render(
      <Harness
        open
        onDismiss={onDismiss}
        triggerRect={{ top: 100, bottom: 120, left: 100, right: 200 }}
      />,
    );
    const portal = screen.getByTestId('popover-portal');
    act(() => {
      fireEvent.mouseDown(portal);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
