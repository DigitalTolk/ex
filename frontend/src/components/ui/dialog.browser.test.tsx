import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
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
