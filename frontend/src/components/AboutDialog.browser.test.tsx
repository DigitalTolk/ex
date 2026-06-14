import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { AboutDialog } from './AboutDialog';

vi.mock('@/hooks/useServerVersion', () => ({
  BUILD_DISPLAY_VERSION: '1.2.3',
  useServerVersion: () => ({ outdated: false }),
}));

describe('AboutDialog browser behaviour', () => {
  it('renders the version, repo link, and logo when open', async () => {
    const screen = await render(<AboutDialog open onOpenChange={() => {}} />);
    await expect.element(screen.getByText(/Version 1\.2\.3/)).toBeVisible();
    const link = screen.getByRole('link', { name: /github\.com\/DigitalTolk\/ex/ });
    await expect.element(link).toBeVisible();
  });

  it('renders nothing visible when closed', async () => {
    await render(<AboutDialog open={false} onOpenChange={() => {}} />);
    const versionNode = document.querySelector('p.text-2xl');
    expect(versionNode).toBeNull();
  });

  it('renders the dialog logo image with an empty alt for decoration', async () => {
    await render(<AboutDialog open onOpenChange={() => {}} />);
    const img = document.querySelector('img[src="/logo.svg"]') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.alt).toBe('');
  });

  it('invokes onClosed once the close animation completes', async () => {
    const onClosed = vi.fn();
    // Disable animations so base-ui's onOpenChangeComplete fires promptly.
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
    document.head.appendChild(style);

    function Harness() {
      const [open, setOpen] = useState(true);
      return <AboutDialog open={open} onOpenChange={setOpen} onClosed={onClosed} />;
    }
    const screen = await render(<Harness />);
    await expect.element(screen.getByText(/Version 1\.2\.3/)).toBeVisible();
    // Close via the built-in close control → real open→close transition →
    // onOpenChangeComplete(false) runs `if (!nextOpen) onClosed?.()`.
    const closeBtn = document.querySelector('[data-slot="dialog-mobile-close"], [data-slot="dialog-close"]') as HTMLElement;
    closeBtn.click();
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalled());
    style.remove();
  });
});
