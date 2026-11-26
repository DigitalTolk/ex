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
  it('Section labels use text-xs (12px) and tiles render large glyphs', async () => {
    renderPicker();
    fireEvent.click(screen.getByLabelText('Open emoji picker'));

    // Default category label — picker opens on the first CLDR group.
    const standardLabel = await screen.findByText('Smileys & Emotion');
    expect(standardLabel.className).toContain('text-xs');
    expect(standardLabel.className).not.toContain('text-[10px]');

    const tile = (await screen.findAllByTestId('emoji-picker-tile'))[0];
    // A square tile as wide as its column: up to 40px, big enough to tell
    // faces apart, and narrower beside a classic scrollbar so all ten columns
    // fit (EmojiPicker.browser.test measures both).
    expect(tile.className).toContain('aspect-square');
    expect(tile.className).toContain('w-full');
    expect(tile.parentElement?.className).toContain('grid-cols-[repeat(10,minmax(0,2.5rem))]');

    // Glyph inside uses the picker size, 28px.
    const glyph = tile.querySelector('span');
    expect(glyph?.className).toContain('text-[28px]');
  });

  it('Search input is text-sm not text-xs', async () => {
    renderPicker();
    fireEvent.click(screen.getByLabelText('Open emoji picker'));

    const search = await screen.findByLabelText('Search emojis');
    expect(search.className).toContain('text-sm');
    expect(search.className).not.toContain('text-xs');
  });
});

// Server-backed frequently-used shelf: stub so opening the picker never hits the network.
vi.mock('@/lib/emoji-frequency', () => ({
  EMOJI_FREQUENCY_CHANGED_EVENT: 'emoji-frequency-changed',
  getFrequentEmojis: vi.fn(async () => []),
  recordEmojiUse: vi.fn(async () => {}),
}));
