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
  mobileSheet,
  estimatedHeight = 100,
  estimatedWidth = 100,
}: {
  open: boolean;
  onDismiss?: () => void;
  triggerRect: { top: number; bottom: number; left: number; right: number };
  preferredAlign?: 'start' | 'end';
  preferredSide?: 'top' | 'bottom';
  mobileSheet?: boolean;
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
        mobileSheet={mobileSheet}
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

  it('calls onDismiss when pressing outside both trigger and content', () => {
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
      fireEvent.pointerDown(screen.getByTestId('outside'));
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

  it('does not call onDismiss when pressing inside the popover', () => {
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
      fireEvent.pointerDown(portal);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('renders mobile sheet presentation when requested on a phone viewport', async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('767px'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    render(
      <Harness
        open
        mobileSheet
        triggerRect={{ top: 500, bottom: 540, left: 100, right: 200 }}
      />,
    );
    const portal = screen.getByTestId('popover-portal');
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
    expect(portal).toHaveAttribute('data-mobile-sheet', 'true');
    expect(portal.style.bottom).toBe('0px');
    expect(portal.style.width).toBe('100vw');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('dismisses a mobile sheet from its scrim', () => {
    const onDismiss = vi.fn();
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('767px'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    render(
      <Harness
        open
        mobileSheet
        onDismiss={onDismiss}
        triggerRect={{ top: 500, bottom: 540, left: 100, right: 200 }}
      />,
    );
    const scrim = document.querySelector('.bg-black\\/35') as HTMLElement;
    expect(scrim).toBeTruthy();
    fireEvent.pointerDown(scrim);
    expect(onDismiss).toHaveBeenCalled();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('dismisses a mobile sheet from a touch-style outside pointer press', () => {
    const onDismiss = vi.fn();
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('767px'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    render(
      <div>
        <Harness
          open
          mobileSheet
          onDismiss={onDismiss}
          triggerRect={{ top: 500, bottom: 540, left: 100, right: 200 }}
        />
        <button data-testid="outside">outside</button>
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId('outside'), { pointerType: 'touch' });
    expect(onDismiss).toHaveBeenCalled();
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('does not lock document scroll for mobile sheets', () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('767px'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const { rerender } = render(
      <Harness
        open
        mobileSheet
        triggerRect={{ top: 500, bottom: 540, left: 100, right: 200 }}
      />,
    );
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.touchAction).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');
    rerender(
      <Harness
        open={false}
        mobileSheet
        triggerRect={{ top: 500, bottom: 540, left: 100, right: 200 }}
      />,
    );
    expect(document.body.style.overflow).toBe('');
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('blurs focused content when the portal unmounts', () => {
    const { unmount } = render(
      <Harness
        open
        triggerRect={{ top: 100, bottom: 120, left: 100, right: 200 }}
      />,
    );
    const button = document.createElement('button');
    screen.getByTestId('popover-portal').appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    unmount();

    expect(document.activeElement).not.toBe(button);
  });
});
