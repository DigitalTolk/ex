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

function rgbParts(color: string) {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
}

function relativeLuminance(color: string) {
  const parts = rgbParts(color);
  if (!parts) {
    const oklch = color.match(/oklch\(([\d.]+)\s+([\d.]+)/);
    if (oklch) return Number(oklch[1]);
    return 0;
  }
  const [r, g, b] = parts.map((value) => {
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
    const shellColor = getComputedStyle(shell).backgroundColor;
    expect(contrastRatio(inputColor, shellColor)).toBeGreaterThanOrEqual(4.5);
  });
});
