import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchBar } from './SearchBar';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue(null),
}));

function renderSearchBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <div data-app-chrome="true" style={{ background: 'var(--color-sidebar)', padding: 12 }}>
          <SearchBar />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Resolve any CSS color string (rgb, rgba, oklch, named, transparent)
// into an [r,g,b,a] sRGB tuple using a transient canvas. Hand-rolled
// parsers were flaky because chromium serializes the same color as
// either `oklch(...)` literal or `rgb(...)` depending on which property
// path is read, and an incorrect parse fall-through silently produced
// 0/0/0/0 → bogus 3.9:1 contrast assertions.
function colorToRGBA(color: string): [number, number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const { data } = ctx.getImageData(0, 0, 1, 1);
  return [data[0], data[1], data[2], data[3] / 255];
}

// If an element's own background is transparent, the rendered pixel
// underneath is whatever its first opaque ancestor paints. Walk up so
// the contrast assertion compares text against the actual visible bg
// rather than rgba(0,0,0,0).
function effectiveBackground(el: HTMLElement): string {
  let node: HTMLElement | null = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    const [, , , a] = colorToRGBA(bg);
    if (a > 0) return bg;
    node = node.parentElement;
  }
  return 'rgb(255, 255, 255)';
}

function relativeLuminance(color: string) {
  const [r, g, b] = colorToRGBA(color).slice(0, 3).map((value) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('SearchBar browser behavior', () => {
  it('keeps search input text readable inside light app chrome', async () => {
    document.documentElement.classList.remove('dark');
    const screen = await renderSearchBar();

    const input = screen.getByTestId('searchbar-input').element();
    const shell = input.parentElement as HTMLElement;
    await expect.element(input).toBeVisible();

    const inputColor = getComputedStyle(input).color;
    const shellColor = effectiveBackground(shell);
    expect(contrastRatio(inputColor, shellColor)).toBeGreaterThanOrEqual(4.5);
  });
});
