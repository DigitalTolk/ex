import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useIsMobile } from './useIsMobile';

// Browser-gate coverage for the legacy addListener/removeListener fallback
// path (older Safari) — modern browsers use addEventListener, which the jsdom
// test already covers.

function Probe() {
  const isMobile = useIsMobile();
  return <span data-testid="mobile" data-v={String(isMobile)} />;
}

describe('useIsMobile legacy matchMedia API (browser)', () => {
  it('subscribes via addListener when addEventListener is unavailable', async () => {
    const cap: { handler: (() => void) | null } = { handler: null };
    const mq = {
      matches: true,
      media: '(max-width: 767px)',
      addListener: (h: () => void) => { cap.handler = h; },
      removeListener: () => {},
      // addEventListener intentionally omitted to force the legacy path.
    };
    const original = window.matchMedia;
    window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
    try {
      const screen = await render(<Probe />);
      expect(screen.getByTestId('mobile').element().getAttribute('data-v')).toBe('true');
      // Flip the media match and fire the legacy change callback.
      mq.matches = false;
      cap.handler?.();
      await vi.waitFor(() => {
        expect(screen.getByTestId('mobile').element().getAttribute('data-v')).toBe('false');
      });
    } finally {
      window.matchMedia = original;
    }
  });

  it('defaults to false and installs no listener when matchMedia is unavailable', async () => {
    // Drives the `typeof window.matchMedia !== 'function'` guard in both
    // readMobileMatch (initial state) and the effect (early return).
    const original = window.matchMedia;
    // @ts-expect-error intentionally removing matchMedia to hit the guard
    delete window.matchMedia;
    try {
      const screen = await render(<Probe />);
      expect(screen.getByTestId('mobile').element().getAttribute('data-v')).toBe('false');
    } finally {
      window.matchMedia = original;
    }
  });
});
