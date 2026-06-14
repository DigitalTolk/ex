import { describe, expect, it } from 'vitest';
import { useRef } from 'react';
import { render } from 'vitest-browser-react';
import { useAtBottomRef } from './useAtBottomRef';

// Browser coverage for the at-bottom tracker. Two shapes: a ref that is
// never attached to a DOM node (the `if (!el) return` guard, line 21)
// and an attached scroller whose scroll events flip the tracked value.

function NullRefProbe() {
  // The ref starts as null and is never wired to a real element, so the
  // effect bails at the `!el` guard. The returned ref keeps its initial
  // `true`.
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useAtBottomRef(scrollRef);
  return <div data-testid="null-probe" data-at-bottom={String(atBottom.current)} />;
}

function AttachedProbe() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useAtBottomRef(scrollRef);
  return (
    <div>
      <div
        ref={scrollRef}
        data-testid="scroller"
        style={{ height: 100, overflowY: 'auto' }}
      >
        <div style={{ height: 1000 }}>tall content</div>
      </div>
      <button
        data-testid="read"
        onClick={(e) =>
          ((e.currentTarget as HTMLButtonElement).dataset.value = String(atBottom.current))
        }
      />
    </div>
  );
}

describe('useAtBottomRef (browser)', () => {
  it('bails out of the effect when the scroll ref is never attached', async () => {
    const screen = await render(<NullRefProbe />);
    // Initialized to true; the unattached ref means no listener was wired.
    expect(screen.getByTestId('null-probe').element().getAttribute('data-at-bottom')).toBe('true');
  });

  it('tracks the at-bottom state from real scroll events', async () => {
    const screen = await render(<AttachedProbe />);
    const scroller = screen.getByTestId('scroller').element() as HTMLDivElement;
    const read = screen.getByTestId('read').element() as HTMLButtonElement;

    // Scroll to the very top — far from the bottom → atBottom should be false.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    read.click();
    expect(read.dataset.value).toBe('false');

    // Scroll to the bottom → within the 120px slack → atBottom true.
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll'));
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    read.click();
    expect(read.dataset.value).toBe('true');
  });
});
