import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './dialog';

// Wiring proof for the mobile back-close: an open dialog pushes a history
// sentinel, and a real history.back() closes it instead of leaving the page.
// The hook's arms are exhaustively unit-tested in jsdom
// (useMobileBackClose.test.ts); this exercises the real-browser traversal.

const isMobileViewport = () => window.innerWidth <= 767;

describe('Dialog mobile back-close', () => {
  it('mobile: hardware/browser Back closes an open dialog', async () => {
    if (!isMobileViewport()) return;
    const onOpenChange = vi.fn();
    await render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Back-close probe</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Back-close probe');
    });
    window.history.back();
    await vi.waitFor(() => {
      expect(onOpenChange).toHaveBeenCalled();
      expect(onOpenChange.mock.calls[0][0]).toBe(false);
    });
  });

  it('mobile: Back on a dialog without onOpenChange is a safe no-op', async () => {
    if (!isMobileViewport()) return;
    await render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Handlerless probe</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Handlerless probe');
    });
    window.history.back();
    // Give the traversal a beat; nothing should throw and the dialog stays.
    await new Promise((r) => setTimeout(r, 150));
    expect(document.body.textContent).toContain('Handlerless probe');
  });

  it('desktop: no history sentinel is pushed for an open dialog', async () => {
    if (isMobileViewport()) return;
    const before = window.history.length;
    await render(
      <Dialog open onOpenChange={vi.fn()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Desktop probe</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Desktop probe');
    });
    expect(window.history.length).toBe(before);
  });
});
