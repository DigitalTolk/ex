import { describe, expect, it, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useTransientOverlayCleanup } from './useTransientOverlayCleanup';

function Harness({ open, lockScroll = true }: { open: boolean; lockScroll?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useTransientOverlayCleanup(open, { rootRef: ref, lockScroll });
  return open ? (
    <div ref={ref}>
      <button type="button">focused</button>
    </div>
  ) : null;
}

describe('useTransientOverlayCleanup', () => {
  afterEach(() => {
    document.body.removeAttribute('style');
    document.getSelection()?.removeAllRanges();
  });

  it('locks document scroll while open and restores it after close', () => {
    document.body.style.overflow = 'auto';
    const { rerender } = render(<Harness open />);

    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.touchAction).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');

    rerender(<Harness open={false} />);

    expect(document.body.style.overflow).toBe('auto');
    expect(document.body.style.touchAction).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');
  });

  it('reference-counts nested overlays before restoring document scroll', () => {
    const { rerender: rerenderOne } = render(<Harness open />);
    const { rerender: rerenderTwo } = render(<Harness open />);

    rerenderOne(<Harness open={false} />);
    expect(document.body.style.overflow).toBe('hidden');

    rerenderTwo(<Harness open={false} />);
    expect(document.body.style.overflow).toBe('');
  });

  it('blurs focused overlay content and clears selection on close', () => {
    const { rerender, getByRole } = render(<Harness open />);
    const button = getByRole('button', { name: 'focused' });
    button.focus();
    expect(document.activeElement).toBe(button);

    rerender(<Harness open={false} />);

    expect(document.activeElement).not.toBe(button);
  });
});
