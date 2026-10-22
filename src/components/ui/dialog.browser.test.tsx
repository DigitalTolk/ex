import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { useDialogMobileAction } from './dialog';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

// Browser coverage for the Dialog primitive's DialogFooter showCloseButton
// branch — most callsites compose their own footer buttons, so the built-in
// Close render path is otherwise unexercised.

const mounted: Array<{ unmount: () => Promise<void> }> = [];
async function mount(ui: React.ReactElement) {
  const result = await render(ui);
  mounted.push(result);
  return result;
}
let killAnims: HTMLStyleElement | null = null;

describe('Dialog primitive browser', () => {
  beforeEach(() => {
    killAnims = document.createElement('style');
    killAnims.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(killAnims);
  });
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.unmount();
    killAnims?.remove();
    killAnims = null;
  });

  it('renders the built-in footer Close button when showCloseButton is set', async () => {
    const screen = await mount(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>With footer close</DialogTitle>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <span>body</span>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    // The `showCloseButton && <DialogPrimitive.Close>Close</...>` arm renders
    // a footer Close button (distinct from the corner X close).
    await expect.element(screen.getByText('With footer close')).toBeVisible();
    const footer = document.querySelector('[data-slot="dialog-footer"]') as HTMLElement;
    const footerClose = Array.from(footer.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Close',
    );
    expect(footerClose).toBeDefined();
    void screen;
  });

  it('omits the footer Close button by default', async () => {
    await mount(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>No footer close</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <span>body</span>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    // The footer's own Close ("Close" label) is absent; only the corner X close exists.
    const footer = document.querySelector('[data-slot="dialog-footer"]');
    expect(footer?.textContent).not.toContain('Close');
  });
});

describe('useDialogMobileAction outside a dialog', () => {
  function Orphan() {
    // No DialogContent above us — the registration context is absent and the
    // hook must be a silent no-op rather than crash.
    useDialogMobileAction({ label: 'Save', onClick: () => undefined });
    return <div data-testid="orphan">ok</div>;
  }

  it('is a no-op when no dialog provides the action slot', async () => {
    await render(<Orphan />);
    expect(document.querySelector('[data-testid="orphan"]')).not.toBeNull();
  });
});

// On a phone a dialog is a full screen with its title in the top row and its
// Close (or Cancel / Save) buttons on the right of it: the two sit level.
describe.skipIf(window.__EX_FORCE_DEVICE__ === 'desktop')('a phone dialog\'s top row', () => {
  let killAnims: HTMLStyleElement | null = null;
  beforeEach(() => {
    killAnims = document.createElement('style');
    killAnims.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(killAnims);
  });
  afterEach(async () => {
    for (const m of mounted.splice(0)) await m.unmount();
    killAnims?.remove();
    killAnims = null;
  });

  const middle = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  };

  it.each([
    ['a Close button', {}, ['dialog-close']],
    ['a Cancel button', { mobileCloseLabel: 'Cancel' }, ['dialog-mobile-close']],
    [
      'Cancel and Save buttons',
      { mobileCloseLabel: 'Cancel', mobileAction: { label: 'Save', onClick: () => undefined } },
      ['dialog-mobile-close', 'dialog-mobile-action'],
    ],
  ] as const)('puts the title level with %s', async (_name, props, slots) => {
    await mount(
      <Dialog open>
        <DialogContent {...props}>
          <DialogHeader>
            <DialogTitle>Set status</DialogTitle>
          </DialogHeader>
          <p>Body</p>
        </DialogContent>
      </Dialog>,
    );
    const title = document.querySelector('[data-slot="dialog-title"]')!;
    await expect.poll(() => title.getBoundingClientRect().height).toBeGreaterThan(0);
    for (const slot of slots) {
      const button = document.querySelector(`[data-slot="${slot}"]`)!;
      expect(Math.abs(middle(title) - middle(button))).toBeLessThanOrEqual(0.5);
    }
  });
});
