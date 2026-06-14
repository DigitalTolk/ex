import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useRef } from 'react';
import { usePopoverPosition } from './usePopoverPosition';

// Browser coverage for the popover placement math: side/align flipping near
// viewport edges, viewport clamping, and the measured-content + ResizeObserver
// path. Placement depends on the live viewport, so it only works in-browser.

interface ProbeProps {
  preferredSide?: 'top' | 'bottom';
  preferredAlign?: 'start' | 'end';
  triggerStyle?: React.CSSProperties;
  withContent?: boolean;
  attachTrigger?: boolean;
}

function Probe({ preferredSide, preferredAlign, triggerStyle, withContent, attachTrigger = true }: ProbeProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(true, triggerRef, {
    preferredSide,
    preferredAlign,
    contentRef: withContent ? contentRef : undefined,
  });
  return (
    <>
      {attachTrigger && (
        <div ref={triggerRef} data-testid="trigger" style={{ position: 'fixed', width: 50, height: 30, ...triggerStyle }} />
      )}
      {withContent && <div ref={contentRef} style={{ width: 200, height: 150 }} />}
      <div
        data-testid="pos"
        data-side={pos.side}
        data-align={pos.align}
        data-measured={String(pos.measured)}
        data-top={Math.round(pos.top)}
        data-left={Math.round(pos.left)}
      />
    </>
  );
}

function posEl() {
  return document.querySelector('[data-testid="pos"]') as HTMLElement;
}

describe('usePopoverPosition (browser)', () => {
  it('places a default popover below the trigger and flags measured after the frame', async () => {
    await render(<Probe triggerStyle={{ top: 100, left: 100 }} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    // Plenty of room below at top:100 → stays on the preferred bottom side.
    // (Horizontal align depends on viewport width, so it's asserted in the
    // dedicated edge tests below.)
    expect(posEl().getAttribute('data-side')).toBe('bottom');
  });

  it('flips a bottom-preferred popover to the top when there is no room below', async () => {
    await render(<Probe triggerStyle={{ top: window.innerHeight - 40, left: 100 }} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    expect(posEl().getAttribute('data-side')).toBe('top');
  });

  it('flips a top-preferred popover to the bottom when there is no room above', async () => {
    await render(<Probe preferredSide="top" triggerStyle={{ top: 5, left: 100 }} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    expect(posEl().getAttribute('data-side')).toBe('bottom');
  });

  it('flips a start-aligned popover to end when it would overflow the right edge', async () => {
    await render(<Probe triggerStyle={{ top: 100, left: window.innerWidth - 60 }} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    expect(posEl().getAttribute('data-align')).toBe('end');
  });

  it('realigns an end-aligned popover to start when it would overflow the left edge', async () => {
    await render(<Probe preferredAlign="end" triggerStyle={{ top: 100, left: 10 }} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    expect(posEl().getAttribute('data-align')).toBe('start');
  });

  it('uses the measured content element dimensions and clamps inside the viewport', async () => {
    await render(<Probe withContent triggerStyle={{ top: window.innerHeight - 40, left: 100 }} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    // Clamped so top stays within the viewport (>= margin 8).
    expect(Number(posEl().getAttribute('data-top'))).toBeGreaterThanOrEqual(8);
  });

  it('stays unmeasured when the trigger element is not mounted', async () => {
    await render(<Probe attachTrigger={false} />);
    // compute() returns early on a null trigger, so measured never flips.
    await new Promise((r) => setTimeout(r, 60));
    expect(posEl().getAttribute('data-measured')).toBe('false');
  });
});
