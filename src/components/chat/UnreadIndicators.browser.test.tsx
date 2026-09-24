import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { useState } from 'react';
import { UnreadDividerRow, type DividerPosition } from './UnreadIndicators';

// Deterministic IntersectionObserver coverage for the divider row: a plain
// scroll box (no virtualization) with the divider placed below, inside and
// above its viewport.
function Harness({ onPosition, spacerAbove }: { onPosition: (p: DividerPosition) => void; spacerAbove: number }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot} data-testid="box" style={{ height: 100, overflowY: 'auto' }}>
      <div style={{ height: spacerAbove }} />
      <UnreadDividerRow root={root} onPosition={onPosition} />
      <div style={{ height: 400 }} />
    </div>
  );
}

describe('UnreadDividerRow (browser)', () => {
  it('reports "below" when the divider sits under the scroller viewport', async () => {
    const onPosition = vi.fn();
    await render(<Harness onPosition={onPosition} spacerAbove={300} />);
    await vi.waitFor(() => expect(onPosition).toHaveBeenCalledWith('below'));
  });

  it('reports "visible" when it is on screen', async () => {
    const onPosition = vi.fn();
    await render(<Harness onPosition={onPosition} spacerAbove={20} />);
    await vi.waitFor(() => expect(onPosition).toHaveBeenCalledWith('visible'));
  });

  it('reports "above" once the reader has scrolled past it', async () => {
    const onPosition = vi.fn();
    const screen = await render(<Harness onPosition={onPosition} spacerAbove={20} />);
    await vi.waitFor(() => expect(onPosition).toHaveBeenCalledWith('visible'));
    const box = screen.getByTestId('box').element() as HTMLElement;
    box.scrollTop = 300;
    await vi.waitFor(() => expect(onPosition).toHaveBeenLastCalledWith('above'));
  });
});
