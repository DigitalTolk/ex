import { describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { render } from 'vitest-browser-react';
import { PopoverPortal } from './PopoverPortal';
import { fireKeyboard, keyboardSettled } from '@/test/keyboard';
import { KeyboardInsetTracker } from '@/test/KeyboardInsetTracker';

// useSwipeDismiss is mocked so the swipe-down dismiss callback can be
// fired directly and both arms of data-swipe-dismissing exercised. The
// Motion drag physics are unit-tested in useSwipeDismiss.test. The hook
// only fires the dismiss callback in sheet mode (renderSheet=true).
const swipe = vi.hoisted(() => ({
  dismissing: false,
  fire: undefined as (() => void) | undefined,
}));
vi.mock('@/hooks/useSwipeDismiss', () => ({
  useSwipeDismiss: (_dir: string, onDismiss: () => void) => {
    swipe.fire = onDismiss;
    return { dismissing: swipe.dismissing, motionProps: {} };
  },
}));

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

  it('swipe-down on the mobile sheet calls onDismiss', async () => {
    if (window.innerWidth >= 768) return;
    swipe.dismissing = false;
    const onDismiss = vi.fn();
    await render(<Harness open={true} onDismiss={onDismiss} mobileSheet={true} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-mobile-sheet="true"]')).not.toBeNull();
    });
    // Fire the captured swipe-down dismiss callback → renderSheet onDismiss.
    swipe.fire?.();
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });

  it('reflects the mid-dismiss state via data-swipe-dismissing=true', async () => {
    if (window.innerWidth >= 768) return;
    swipe.dismissing = true;
    await render(<Harness open={true} mobileSheet={true} />);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-swipe-dismissing="true"]')).not.toBeNull();
    });
    swipe.dismissing = false;
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

// A sheet's content often raises the keyboard (the emoji and GIF pickers'
// search fields): the sheet sits on the keyboard, so what the field finds
// stays in sight. It used to stay at the bottom of the screen, under it.
describe.runIf(window.innerWidth < 768)('PopoverPortal sheet with the keyboard up', () => {
  const KEYBOARD_PX = 300;
  const sheet = () => document.querySelector('[data-testid="popover-portal"]') as HTMLElement;
  const bottomAt = (y: number) => Math.round(sheet().getBoundingClientRect().bottom) === y;

  it('sits on the keyboard, and back at the bottom once it goes', async () => {
    await render(
      <>
        <KeyboardInsetTracker />
        <Harness open={true} mobileSheet={true} />
      </>,
    );
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    expect(Math.round(sheet().getBoundingClientRect().bottom)).toBe(window.innerHeight);
    try {
      fireKeyboard('keyboardWillShow', KEYBOARD_PX);
      await keyboardSettled(() => bottomAt(window.innerHeight - KEYBOARD_PX));
      const box = sheet().getBoundingClientRect();
      expect(Math.round(box.bottom)).toBe(window.innerHeight - KEYBOARD_PX);
      expect(box.top).toBeGreaterThanOrEqual(0);
      // The home indicator is under the keyboard: no room kept for it.
      expect(sheet().style.getPropertyValue('--sheet-safe-bottom')).toBe('0px');
    } finally {
      fireKeyboard('keyboardWillHide');
    }
    await keyboardSettled(() => bottomAt(window.innerHeight));
    expect(Math.round(sheet().getBoundingClientRect().bottom)).toBe(window.innerHeight);
    expect(sheet().style.getPropertyValue('--sheet-safe-bottom')).toContain('safe-area-inset-bottom');
  });

  it('is no taller than the space above the keyboard', async () => {
    await render(
      <>
        <KeyboardInsetTracker />
        <Harness open={true} mobileSheet={true} />
      </>,
    );
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    // A keyboard leaving less than half the screen (a landscape phone).
    const keyboard = Math.round(window.innerHeight * 0.7);
    try {
      fireKeyboard('keyboardWillShow', keyboard);
      await keyboardSettled(() => bottomAt(window.innerHeight - keyboard));
      sheet().style.height = '100dvh';
      const box = sheet().getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(-1);
      expect(Math.round(box.bottom)).toBe(window.innerHeight - keyboard);
    } finally {
      fireKeyboard('keyboardWillHide');
    }
  });
});
