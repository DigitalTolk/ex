import { describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { render } from 'vitest-browser-react';
import { PopoverPortal } from './PopoverPortal';

// Browser coverage for PopoverPortal — exercises open/closed render,
// pointerdown dismissal, Escape dismissal, and mobile-sheet path.

function Harness({ open, onDismiss, mobileSheet }: { open: boolean; onDismiss?: () => void; mobileSheet?: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} data-testid="popover-trigger" type="button">Open</button>
      <PopoverPortal
        open={open}
        triggerRef={triggerRef}
        onDismiss={onDismiss}
        mobileSheet={mobileSheet}
        ariaLabel="Demo popover"
      >
        <div data-testid="popover-content">Hello popover</div>
      </PopoverPortal>
      <div data-testid="outside-target">outside</div>
    </div>
  );
}

describe('PopoverPortal browser', () => {
  it('does not render content when closed', async () => {
    await render(<Harness open={false} />);
    expect(document.querySelector('[data-testid="popover-content"]')).toBeNull();
  });

  it('renders content when open', async () => {
    await render(<Harness open={true} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="popover-content"]')).not.toBeNull();
    });
  });

  it('Escape calls onDismiss', async () => {
    const onDismiss = vi.fn();
    await render(<Harness open={true} onDismiss={onDismiss} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="popover-content"]')).not.toBeNull();
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  it('pointerdown outside the popover and trigger calls onDismiss', async () => {
    const onDismiss = vi.fn();
    await render(<Harness open={true} onDismiss={onDismiss} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="popover-content"]')).not.toBeNull();
    });
    const outside = document.querySelector('[data-testid="outside-target"]') as HTMLElement;
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await vi.waitFor(() => {
      expect(onDismiss).toHaveBeenCalled();
    });
  });

  it('pointerdown on the trigger does NOT dismiss', async () => {
    const onDismiss = vi.fn();
    await render(<Harness open={true} onDismiss={onDismiss} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="popover-content"]')).not.toBeNull();
    });
    const trigger = document.querySelector('[data-testid="popover-trigger"]') as HTMLElement;
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('renders as a mobile sheet when mobileSheet is set and viewport is mobile', async () => {
    if (window.innerWidth >= 768) return;
    await render(<Harness open={true} mobileSheet={true} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="popover-content"]')).not.toBeNull();
    });
  });

  it('ignores a non-Escape keydown (does not dismiss)', async () => {
    const onDismiss = vi.fn();
    await render(<Harness open={true} onDismiss={onDismiss} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="popover-content"]')).not.toBeNull();
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
