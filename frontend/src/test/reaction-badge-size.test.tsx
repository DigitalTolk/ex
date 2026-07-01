import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

vi.mock('@/components/ui/dropdown-menu');

function renderItem(msg: Message) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageItem
          message={msg}
          authorName="Alice"
          isOwn={false}
          channelId="ch-1"
          currentUserId="u-me"
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('Reaction badge — 14px font size pin', () => {
  it('badge button is text-sm; the count is slightly smaller (text-xs) but vertically centered', () => {
    const msg: Message = {
      id: 'm-1',
      parentID: 'ch-1',
      authorID: 'u-other',
      body: 'hi',
      createdAt: '2026-04-26T10:00:00Z',
      reactions: { ':+1:': ['u-1', 'u-2'] },
    };
    renderItem(msg);
    const badge = screen.getByTestId('reaction-badge');
    expect(badge.className).toContain('text-sm');
    expect(badge.className).not.toContain('text-xs');
    // The pill flex-centers its children, so the smaller count stays middle-aligned.
    expect(badge.className).toContain('items-center');

    // The numeric count is a touch smaller than the badge text.
    const count = badge.querySelector('span:last-child');
    expect(count?.textContent).toBe('2');
    expect(count?.className).toContain('text-xs');
    expect(count?.className).not.toContain('text-sm');
  });

  it('the emoji glyph inside the badge is rendered at text-base (16px, to match the add-reaction icon)', () => {
    const msg: Message = {
      id: 'm-1',
      parentID: 'ch-1',
      authorID: 'u-other',
      body: 'hi',
      createdAt: '2026-04-26T10:00:00Z',
      reactions: { '🎉': ['u-1'] },
    };
    renderItem(msg);
    const badge = screen.getByTestId('reaction-badge');
    // The emoji glyph uses EmojiGlyph size="md" (text-base) so it reads at the
    // same visual weight as the 16px SmilePlus placeholder rather than looking
    // undersized; the badge text/count stay at text-sm/text-xs.
    const glyph = badge.querySelector('span.leading-none');
    expect(glyph).not.toBeNull();
    expect(glyph?.className).toContain('text-base');
  });

  it('renders split skin-tone reaction shortcodes as one emoji glyph', () => {
    const msg: Message = {
      id: 'm-1',
      parentID: 'ch-1',
      authorID: 'u-other',
      body: 'hi',
      createdAt: '2026-04-26T10:00:00Z',
      reactions: { ':hand::skin-tone-3:': ['u-1'] },
    };
    renderItem(msg);
    const badge = screen.getByTestId('reaction-badge');
    const glyph = badge.querySelector('span.leading-none');
    expect(glyph?.textContent).toBe('🖐🏽');
  });

  it('renders picker-only standard shortcode reactions', () => {
    const msg: Message = {
      id: 'm-1',
      parentID: 'ch-1',
      authorID: 'u-other',
      body: 'hi',
      createdAt: '2026-04-26T10:00:00Z',
      reactions: { ':laughing:': ['u-1'] },
    };
    renderItem(msg);
    const badge = screen.getByTestId('reaction-badge');
    const glyph = badge.querySelector('span.leading-none');
    expect(glyph?.textContent).toBe('😆');
  });
});
