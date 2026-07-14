import { describe, expect, it, vi, afterEach } from 'vitest';
import { useRef } from 'react';
import { render, cleanup } from 'vitest-browser-react';
import { PopoverPortal } from './PopoverPortal';
import { swipe } from '@/test/gestures';

// REAL-surface proof that a downward finger drag dismisses the mobile bottom
// sheet. PopoverPortal spreads the REAL useSwipeDismiss('down', …) motionProps
// onto its <motion.div> only in mobile-sheet mode; a genuine downward drag past
// the threshold must fire onDismiss. Every other PopoverPortal test mocks the
// hook — this one drives Motion's real drag engine via swipe().

afterEach(() => cleanup());

function Harness({ onDismiss, children }: { onDismiss: () => void; children?: React.ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} data-testid="popover-trigger" type="button">
        Open
      </button>
      <PopoverPortal open triggerRef={triggerRef} onDismiss={onDismiss} mobileSheet ariaLabel="Demo sheet">
        {children ?? <div data-testid="popover-content">Hello sheet</div>}
      </PopoverPortal>
    </div>
  );
}

const sheet = () => document.querySelector('[data-testid="popover-portal"][data-mobile-sheet="true"]') as HTMLElement | null;

describe('PopoverPortal mobile sheet — real swipe-to-dismiss', () => {
  it('a DOWN swipe past the threshold calls onDismiss', async () => {
    if (window.innerWidth > 767) return; // sheet + drag only on mobile
    const onDismiss = vi.fn();
    await render(<Harness onDismiss={onDismiss} />);
    await vi.waitFor(() => expect(sheet()).not.toBeNull());

    // A real downward drag well past DISMISS_DISTANCE (72px).
    await swipe(sheet()!, { dy: 200, steps: 8, stepMs: 18 });

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });

  it('a small DOWN swipe below the threshold does NOT dismiss', async () => {
    if (window.innerWidth > 767) return;
    const onDismiss = vi.fn();
    await render(<Harness onDismiss={onDismiss} />);
    await vi.waitFor(() => expect(sheet()).not.toBeNull());

    // 40px (< 72px) released slowly (settle → ~0 velocity): stays open.
    await swipe(sheet()!, { dy: 40, steps: 5, stepMs: 24, settle: true });

    await new Promise((r) => setTimeout(r, 60));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('a swipe on a SCROLLABLE body never arms the dismiss drag (emoji-picker scroll regression)', async () => {
    if (window.innerWidth > 767) return;
    const onDismiss = vi.fn();
    await render(
      <Harness onDismiss={onDismiss}>
        <div
          data-testid="tall-scroller"
          data-swipe-scroll="true"
          style={{ height: 120, overflowY: 'auto' }}
        >
          <div style={{ height: 600 }}>tall content</div>
        </div>
      </Harness>,
    );
    await vi.waitFor(() => expect(sheet()).not.toBeNull());

    // Even at scrollTop 0 a scrollable body belongs to native scroll — a
    // down-drag over it must NOT dismiss the sheet (pre-fix it did, and the
    // captured gesture was also why the picker grid could never scroll).
    const scroller = document.querySelector('[data-testid="tall-scroller"]') as HTMLElement;
    await swipe(scroller, { dy: 200, steps: 8, stepMs: 18 });

    await new Promise((r) => setTimeout(r, 60));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('a swipe on a short (non-scrollable) swipe-scroll body still dismisses', async () => {
    if (window.innerWidth > 767) return;
    const onDismiss = vi.fn();
    await render(
      <Harness onDismiss={onDismiss}>
        <div
          data-testid="short-scroller"
          data-swipe-scroll="true"
          style={{ height: 120, overflowY: 'auto' }}
        >
          <div style={{ height: 40 }}>short content</div>
        </div>
      </Harness>,
    );
    await vi.waitFor(() => expect(sheet()).not.toBeNull());

    const scroller = document.querySelector('[data-testid="short-scroller"]') as HTMLElement;
    await swipe(scroller, { dy: 200, steps: 8, stepMs: 18 });

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });
});
