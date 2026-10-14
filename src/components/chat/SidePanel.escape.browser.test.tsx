import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { SidePanel } from './SidePanel';
import { PopoverPortal } from '@/components/PopoverPortal';
import { startInputModalityTracking } from '@/lib/input-modality';

// The reported flow, with a real mouse and keyboard: open a right-hand panel
// with a click, press Escape. The panel closes, and the button that opened it
// does not light up with a keyboard focus ring.

startInputModalityTracking();

function Harness({ withPopover = false }: { withPopover?: boolean }) {
  const [open, setOpen] = useState(false);
  const [popover, setPopover] = useState(withPopover);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div style={{ display: 'flex', height: 600 }}>
      <button type="button" data-testid="members-button" onClick={() => setOpen((v) => !v)}>
        Members
      </button>
      {open && (
        <SidePanel title="Members" ariaLabel="Members" closeLabel="Close members" onClose={() => setOpen(false)}>
          <button type="button" ref={trigger}>picker</button>
          <PopoverPortal open={popover} onDismiss={() => setPopover(false)} triggerRef={trigger} ariaLabel="Emoji picker">
            <div>emoji</div>
          </PopoverPortal>
        </SidePanel>
      )}
    </div>
  );
}

const panel = () => document.querySelector('aside[aria-label="Members"]');

describe('Escape on a right-hand panel', () => {
  it('closes the panel a click opened, without a focus ring on the button', async () => {
    if (window.innerWidth <= 767) return; // the desktop rail
    const screen = await render(<Harness />);
    const button = screen.getByTestId('members-button');
    await button.click();
    await vi.waitFor(() => expect(panel()).not.toBeNull());

    await userEvent.keyboard('{Escape}');

    await vi.waitFor(() => expect(panel()).toBeNull());
    const el = button.element() as HTMLElement;
    await vi.waitFor(() => expect(el.matches(':focus-visible')).toBe(false));
  });

  it('an Escape the popover above takes leaves the panel open', async () => {
    if (window.innerWidth <= 767) return;
    const screen = await render(<Harness withPopover />);
    await screen.getByTestId('members-button').click();
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Emoji picker"]')).not.toBeNull());

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(document.querySelector('[aria-label="Emoji picker"]')).toBeNull());
    expect(panel()).not.toBeNull();

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(panel()).toBeNull());
  });
});
