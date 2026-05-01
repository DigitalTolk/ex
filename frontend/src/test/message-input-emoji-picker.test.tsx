import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), data: [] }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { MessageInput } from '@/components/chat/MessageInput';

function renderInput() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MessageInput onSend={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe('MessageInput — emoji picker integration', () => {
  beforeEach(() => {
    document.execCommand = vi.fn(() => true) as unknown as typeof document.execCommand;
  });

  it('clicking the toolbar Emoji button opens the picker', () => {
    renderInput();
    fireEvent.click(screen.getByLabelText('Emoji'));
    // The popover renders the search input — that's the most stable
    // ground-truth signal that the picker actually opened.
    expect(screen.getByLabelText('Search emojis')).toBeInTheDocument();
  });

  it('picking an emoji inserts the shortcode into the editor', async () => {
    // Regression: the emoji button stole focus from the editor and the
    // shortcode never landed. Tiptap drives inserts through editor
    // commands rather than execCommand, so we assert the visible
    // outcome: the editor's text content gains a `:name:` token.
    renderInput();
    fireEvent.click(screen.getByLabelText('Emoji'));
    fireEvent.click(screen.getAllByTestId('emoji-picker-tile')[0]);

    await waitFor(() => {
      const editor = screen.getByLabelText('Message input');
      expect(editor.textContent ?? '').toMatch(/:[a-z0-9_+-]+:/i);
    });
  });

  it('picking an emoji closes the picker', async () => {
    renderInput();
    fireEvent.click(screen.getByLabelText('Emoji'));
    expect(screen.getByLabelText('Search emojis')).toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId('emoji-picker-tile')[0]);
    // Picker dismissed: the search input is gone.
    expect(screen.queryByLabelText('Search emojis')).toBeNull();
  });

  it('inserts a shortcode even when the editor was never focused first', async () => {
    // Reproduces the user-reported case: composer just mounted, user
    // hasn't typed anything. The picker's onSelect path must focus the
    // editor before inserting so the shortcode actually lands.
    renderInput();
    fireEvent.click(screen.getByLabelText('Emoji'));
    fireEvent.click(screen.getAllByTestId('emoji-picker-tile')[0]);
    await waitFor(() => {
      expect(screen.getByLabelText('Message input').textContent ?? '').toMatch(/:[a-z0-9_+-]+:/i);
    });
  });

  it('the emoji search input filters the visible tiles', async () => {
    // Sanity: the picker's own filtering still works inside the
    // composer. Locks down the toolbar wiring so a future regression
    // (e.g. mode prop change, popover swap) can't silently break the
    // search box.
    renderInput();
    fireEvent.click(screen.getByLabelText('Emoji'));
    const search = screen.getByLabelText('Search emojis') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'thumbs' } });
    // At least one match (👍 / :thumbsup:) survives; everything else
    // is filtered out, so the tile count drops well below the full
    // standard-set length.
    const filtered = screen.getAllByTestId('emoji-picker-tile');
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(20);
    const popover = search.closest('[role="dialog"]') ?? search.parentElement!;
    expect(within(popover).getByText('Standard')).toBeInTheDocument();
  });
});
