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
  estimatedHeight?: number;
}

function Probe({ preferredSide, preferredAlign, triggerStyle, withContent, attachTrigger = true, estimatedHeight }: ProbeProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pos = usePopoverPosition(true, triggerRef, {
    preferredSide,
    preferredAlign,
    estimatedHeight,
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

  it('uses the default options object when called with no opts argument', async () => {
    function NoOpts() {
      const triggerRef = useRef<HTMLDivElement>(null);
      // No options arg → the `opts: Options = {}` default applies.
      const pos = usePopoverPosition(true, triggerRef);
      return (
        <>
          <div ref={triggerRef} data-testid="trigger" style={{ position: 'fixed', top: 120, left: 120, width: 40, height: 24 }} />
          <div data-testid="pos" data-measured={String(pos.measured)} data-side={pos.side} />
        </>
      );
    }
    await render(<NoOpts />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    // Defaults: preferredSide bottom with plenty of room below.
    expect(posEl().getAttribute('data-side')).toBe('bottom');
  });

  it('resets measured back to false when the popover closes', async () => {
    function Toggle({ open }: { open: boolean }) {
      const triggerRef = useRef<HTMLDivElement>(null);
      const pos = usePopoverPosition(open, triggerRef, {});
      return (
        <>
          <div ref={triggerRef} data-testid="trigger" style={{ position: 'fixed', top: 100, left: 100, width: 40, height: 24 }} />
          <div data-testid="pos" data-measured={String(pos.measured)} />
        </>
      );
    }
    const screen = await render(<Toggle open />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    // Re-render closed → the `prev.measured ? { ...prev, measured:false } :
    // prev` reset arm fires.
    await screen.rerender(<Toggle open={false} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('false'));
  });

  it('keeps an end-aligned popover end-aligned when it fits to the left', async () => {
    // Trigger near the right edge so an end-aligned popover (right edges
    // aligned) comfortably fits → the `rect.right - width - margin < 0`
    // realign condition is false and align stays "end".
    await render(<Probe preferredAlign="end" triggerStyle={{ top: 100, left: window.innerWidth - 100 }} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    expect(posEl().getAttribute('data-align')).toBe('end');
  });

  it('clamps a popover whose trigger sits past the right/bottom edge back inside the viewport', async () => {
    // Trigger pinned to the far bottom-right forces both the left-clamp
    // (`left + width + margin > vw`) and top-clamp arms.
    await render(
      <Probe
        withContent
        triggerStyle={{ top: window.innerHeight - 10, left: window.innerWidth - 10 }}
      />,
    );
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    const top = Number(posEl().getAttribute('data-top'));
    const left = Number(posEl().getAttribute('data-left'));
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left).toBeLessThanOrEqual(window.innerWidth);
  });

  it('clamps the vertical position for a popover taller than the room below', async () => {
    // Trigger near the top (so it stays bottom-aligned — little room above to
    // flip to) with content taller than the viewport → the bottom-side top
    // (rect.bottom+4) plus the huge height exceeds vh, so `top + height +
    // margin > vh` fires and pins top inside the viewport.
    await render(
      <Probe estimatedHeight={2000} triggerStyle={{ top: 50, left: 100 }} />,
    );
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    const top = Number(posEl().getAttribute('data-top'));
    expect(posEl().getAttribute('data-side')).toBe('bottom');
    expect(top).toBeGreaterThanOrEqual(8);
  });

  it('starts measured=false and does not re-measure when opened with open=false', async () => {
    function ClosedProbe() {
      const triggerRef = useRef<HTMLDivElement>(null);
      // open=false from the start → the effect's `prev.measured ? ... : prev`
      // takes the `: prev` arm (measured already false, no state change).
      const pos = usePopoverPosition(false, triggerRef, {});
      return (
        <>
          <div ref={triggerRef} data-testid="trigger" style={{ position: 'fixed', top: 100, left: 100 }} />
          <div data-testid="pos" data-measured={String(pos.measured)} />
        </>
      );
    }
    await render(<ClosedProbe />);
    await new Promise((r) => setTimeout(r, 40));
    expect(posEl().getAttribute('data-measured')).toBe('false');
  });

  it('clamps the left edge up to the margin when the trigger sits at the far left', async () => {
    // Start-aligned trigger pinned at left:2 → computed left (rect.left=2) is
    // below the 8px margin, so the `left < margin` clamp bumps it to 8.
    await render(<Probe triggerStyle={{ top: 100, left: 2 }} />);
    await vi.waitFor(() => expect(posEl().getAttribute('data-measured')).toBe('true'));
    expect(Number(posEl().getAttribute('data-left'))).toBe(8);
  });
});
