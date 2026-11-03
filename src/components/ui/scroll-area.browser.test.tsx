import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';
import { ScrollArea } from './scroll-area';

// The scroll area sets its overflow variables on the viewport at every
// scroll event. Inherited, each change restyled everything inside it: on
// Safari, scrolling the full sidebar's thousand rows ran at about 10 frames a
// second.
describe('ScrollArea overflow variables', () => {
  it('stay on the viewport, not passed down to what scrolls in it', async () => {
    const screen = await render(
      <ScrollArea style={{ height: 100 }}>
        <div data-testid="content" style={{ height: 1000 }} />
      </ScrollArea>,
    );
    const content = screen.getByTestId('content').element() as HTMLElement;
    const viewport = content.parentElement!;
    viewport.scrollTop = 200;
    viewport.dispatchEvent(new Event('scroll'));

    await expect.poll(() => viewport.style.getPropertyValue('--scroll-area-overflow-y-start')).toBe('200px');
    expect(getComputedStyle(content).getPropertyValue('--scroll-area-overflow-y-start').trim()).toBe('0px');
  });
});
