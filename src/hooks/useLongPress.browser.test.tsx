import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { useLongPress } from './useLongPress';

vi.mock('@/lib/haptics', () => ({ triggerMessageActionHaptic: vi.fn() }));

// Browser twins for the arms the row/message consumers never exercise:
// the option defaults (every consumer passes enabled/delayMs explicitly)
// and a drift below the cancel threshold that must NOT abort the press.

function Probe({ onLongPress }: { onLongPress: () => void }) {
  // Defaults on purpose: enabled=true, delayMs=450.
  const { handlers } = useLongPress({ onLongPress });
  return <div data-testid="press-target" style={{ width: 120, height: 48 }} {...handlers} />;
}

let active: { unmount: () => Promise<void> } | null = null;
afterEach(async () => {
  if (active) await active.unmount();
  active = null;
});

function pointer(type: string, x: number, y: number) {
  return new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 7, pointerType: 'touch' });
}

describe('useLongPress (browser, defaults)', () => {
  it('fires after the default hold, tolerating drift below the cancel threshold', async () => {
    const onLongPress = vi.fn();
    const result = await render(<Probe onLongPress={onLongPress} />);
    active = result;
    const el = document.querySelector('[data-testid="press-target"]') as HTMLElement;

    el.dispatchEvent(pointer('pointerdown', 50, 20));
    // 6px of drift — under the 10px threshold, the press must survive.
    el.dispatchEvent(pointer('pointermove', 56, 20));
    expect(onLongPress).not.toHaveBeenCalled();
    await expect.poll(() => onLongPress.mock.calls.length, { timeout: 2000 }).toBe(1);
  });
});
