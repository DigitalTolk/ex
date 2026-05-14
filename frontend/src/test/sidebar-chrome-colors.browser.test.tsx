import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

// The sidebar uses raw Tailwind dark-palette utilities (text-white,
// bg-white/10, hover:bg-white/15, …) that are remapped via index.css
// when the document is in light mode. Previously those overrides
// relied on `!important`. After dropping `!important`, this suite
// locks the computed colors so a future cascade change can't silently
// regress to white-on-white text or hard-black hovers.
//
// Each assertion paints a tiny 1×1 sample with one of the affected
// utility classes inside a `data-app-chrome="true"` parent and reads
// back the resolved computed style. We don't compare RGB tuples
// exactly (browsers serialize oklch differently across versions);
// instead we assert the visual contrast against a reference colour.

function paint(color: string): [number, number, number] {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function relativeLuminance(rgb: [number, number, number]) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function computedColor(el: HTMLElement, prop: 'color' | 'backgroundColor') {
  return paint(getComputedStyle(el)[prop]);
}

describe('sidebar app-chrome color remap (light mode)', () => {
  it('keeps text-white readable on the light sidebar (no white-on-white)', async () => {
    document.documentElement.classList.remove('dark');
    const screen = await render(
      <div data-app-chrome="true" data-testid="probe-shell" style={{ background: 'var(--color-sidebar)', padding: 8 }}>
        <span data-testid="probe-text" className="text-white">probe</span>
      </div>,
    );
    const text = screen.getByTestId('probe-text').element() as HTMLElement;
    const shell = screen.getByTestId('probe-shell').element() as HTMLElement;
    const bgLum = relativeLuminance(computedColor(shell, 'backgroundColor'));
    const fgLum = relativeLuminance(computedColor(text, 'color'));
    expect(bgLum - fgLum).toBeGreaterThan(0.4);
  });

  it('renders bg-white/10 as a visible light-grey wash, not transparent or pure white', async () => {
    document.documentElement.classList.remove('dark');
    const screen = await render(
      <div data-app-chrome="true">
        <div data-testid="probe-bg" className="bg-white/10" style={{ width: 16, height: 16 }} />
      </div>,
    );
    const el = screen.getByTestId('probe-bg').element() as HTMLElement;
    const [r, g, b] = computedColor(el, 'backgroundColor');
    expect(r).toBeGreaterThanOrEqual(220);
    expect(r).toBeLessThan(255);
    expect(Math.abs(r - g)).toBeLessThan(5);
    expect(Math.abs(g - b)).toBeLessThan(5);
  });

  it('falls through to dark palette in dark mode (no remap leaks)', async () => {
    document.documentElement.classList.add('dark');
    const screen = await render(
      <div data-app-chrome="true">
        <span data-testid="probe-dark" className="text-white">probe</span>
      </div>,
    );
    const text = screen.getByTestId('probe-dark').element() as HTMLElement;
    const [r, g, b] = computedColor(text, 'color');
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(255);
    document.documentElement.classList.remove('dark');
  });
});
