import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiPicker } from '@/components/EmojiPicker';

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
}));

function renderPicker() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EmojiPicker onSelect={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('EmojiPicker — readable sizes', () => {
  it('Section labels use text-sm (14px) and tiles render large glyphs', async () => {
    renderPicker();
    fireEvent.click(screen.getByLabelText('Open emoji picker'));

    const standardLabel = await screen.findByText('Standard');
    expect(standardLabel.className).toContain('text-sm');
    expect(standardLabel.className).not.toContain('text-[10px]');

    const tile = (await screen.findAllByTestId('emoji-picker-tile'))[0];
    // Tile is 36px (h-9 w-9), fitting a large glyph.
    expect(tile.className).toContain('h-9');
    expect(tile.className).toContain('w-9');

    // Glyph inside should use text-2xl (lg size).
    const glyph = tile.querySelector('span');
    expect(glyph?.className).toContain('text-2xl');
  });

  it('Search input is text-sm not text-xs', async () => {
    renderPicker();
    fireEvent.click(screen.getByLabelText('Open emoji picker'));

    const search = await screen.findByLabelText('Search emojis');
    expect(search.className).toContain('text-sm');
    expect(search.className).not.toContain('text-xs');
  });
});
