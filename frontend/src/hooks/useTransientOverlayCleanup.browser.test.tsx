import { describe, expect, it, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { useRef } from 'react';
import { useTransientOverlayCleanup } from './useTransientOverlayCleanup';

// Browser coverage for the overlay scroll-lock + focus-cleanup hook (no
// browser test previously). Teardown runs in the effect cleanup, so we drive
// it by awaiting unmount().

function Probe({ lockScroll = false, withRoot = false }: { lockScroll?: boolean; withRoot?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useTransientOverlayCleanup(true, { rootRef: withRoot ? rootRef : undefined, lockScroll });
  return (
    <div ref={rootRef}>
      <input data-testid="overlay-input" />
    </div>
  );
}

const mounted: Array<{ unmount: () => Promise<void> }> = [];
async function mount(ui: React.ReactElement) {
  const result = await render(ui);
  mounted.push(result);
  return result;
}

afterEach(async () => {
  for (const m of mounted.splice(0)) await m.unmount();
  document.body.style.overflow = '';
});

describe('useTransientOverlayCleanup (browser)', () => {
  it('locks document scroll while open and restores it on close', async () => {
    document.body.style.overflow = 'auto';
    const result = await mount(<Probe lockScroll />);
    expect(document.body.style.overflow).toBe('hidden');
    await result.unmount();
    mounted.length = 0;
    expect(document.body.style.overflow).toBe('auto');
  });

  it('reference-counts nested locks (one close does not unlock)', async () => {
    document.body.style.overflow = '';
    const a = await mount(<Probe lockScroll />);
    const b = await mount(<Probe lockScroll />);
    expect(document.body.style.overflow).toBe('hidden');
    // Closing one overlay leaves the lock in place (depth still > 0).
    await a.unmount();
    expect(document.body.style.overflow).toBe('hidden');
    // Closing the last one restores the original overflow.
    await b.unmount();
    mounted.length = 0;
    expect(document.body.style.overflow).toBe('');
  });

  it('blurs the focused element inside the root on cleanup', async () => {
    const screen = await mount(<Probe withRoot />);
    const input = screen.getByTestId('overlay-input').element() as HTMLInputElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    await mounted[mounted.length - 1].unmount();
    mounted.length = 0;
    expect(document.activeElement).not.toBe(input);
  });

  it('blurs the active element even without a root ref', async () => {
    const screen = await mount(<Probe />);
    const input = screen.getByTestId('overlay-input').element() as HTMLInputElement;
    input.focus();
    await mounted[mounted.length - 1].unmount();
    mounted.length = 0;
    expect(document.activeElement).not.toBe(input);
  });
});
