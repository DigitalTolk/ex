import { describe, it, expect } from 'vitest';
import { render } from 'vitest-browser-react';
import { PresenceDot } from './PresenceDot';
import { presenceNotchStyle } from '@/lib/presence';

// Browser twin of PresenceDot.test.tsx — pins the same filled/hollow shape
// contract under the real engine, including the bare-default render no
// production call site exercises (they all pass explicit sizes).
describe('PresenceDot (browser)', () => {
  it('renders with all defaults: 8px, flush to the corner, filled when online', async () => {
    const screen = await render(
      <span style={{ position: 'relative', display: 'inline-block', width: 28, height: 28 }}>
        <PresenceDot online />
      </span>,
    );
    const dot = screen.container.querySelector('[data-presence]') as HTMLElement;
    expect(dot.getAttribute('data-presence')).toBe('online');
    expect(dot.className).toContain('bg-online');
    const style = getComputedStyle(dot);
    expect(style.width).toBe('8px');
    expect(style.right).toBe('0px');
    expect(style.bottom).toBe('0px');
  });

  it('offline is a hollow ring — border only, transparent center', async () => {
    const screen = await render(
      <span style={{ position: 'relative', display: 'inline-block', width: 28, height: 28 }}>
        <PresenceDot online={false} size={12} testId="dot" />
      </span>,
    );
    const dot = screen.getByTestId('dot').element() as HTMLElement;
    const style = getComputedStyle(dot);
    expect(parseFloat(style.borderTopWidth)).toBeGreaterThanOrEqual(1.5);
    expect(style.backgroundColor).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  it('the notch mask evaluates to a real radial-gradient in the engine', async () => {
    const screen = await render(
      <span data-testid="masked" style={{ width: 28, height: 28, ...presenceNotchStyle(8) }} />,
    );
    const el = screen.getByTestId('masked').element() as HTMLElement;
    expect(getComputedStyle(el).maskImage).toContain('radial-gradient');
  });
});
