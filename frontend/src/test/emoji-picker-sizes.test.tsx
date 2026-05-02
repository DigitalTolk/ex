import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EmojiPicker } from '@/components/EmojiPicker';

const authMock = vi.hoisted(() => ({
  user: {
    id: 'u-1',
    email: 'u@example.com',
    displayName: 'User',
    systemRole: 'member' as const,
    status: 'active',
    emojiSkinTone: '' as const,
  },
  setAuth: vi.fn(),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
}));

vi.mock('@/context/AuthContext', () => ({
  useOptionalAuth: () => authMock,
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getAccessToken: () => 'tok',
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

    // Default category label — picker opens on the first CLDR group.
    const standardLabel = await screen.findByText('Smileys & Emotion');
    expect(standardLabel.className).toContain('text-sm');
    expect(standardLabel.className).not.toContain('text-[10px]');

    const tile = (await screen.findAllByTestId('emoji-picker-tile'))[0];
    // Tile is 32px (h-8 w-8), keeping the grid dense while fitting a large glyph.
    expect(tile.className).toContain('h-8');
    expect(tile.className).toContain('w-8');

    // Glyph inside should use text-[22px] (lg size — 2px less than text-2xl
    // so the picker doesn't feel cluttered).
    const glyph = tile.querySelector('span');
    expect(glyph?.className).toContain('text-[22px]');
  });

  it('Search input is text-sm not text-xs', async () => {
    renderPicker();
    fireEvent.click(screen.getByLabelText('Open emoji picker'));

    const search = await screen.findByLabelText('Search emojis');
    expect(search.className).toContain('text-sm');
    expect(search.className).not.toContain('text-xs');
  });
});
