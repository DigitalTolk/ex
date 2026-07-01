import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

const editMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: editMutate, isPending: false }),
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

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    parentID: 'ch-1',
    authorID: 'u-1',
    body: 'hello *world*',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

describe('MessageItem inline edit', () => {
  beforeEach(() => {
    editMutate.mockReset();
  });

  it('clicking Edit shows the full MessageInput composer prefilled on desktop', async () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn
        channelId="ch-1"
        currentUserId="u-1"
      />,
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(await screen.findByTestId('inline-edit')).toBeInTheDocument();
    const editor = screen.getByLabelText('Message input');
    expect(editor.textContent ?? '').toContain('hello');
    expect(editor.textContent ?? '').toContain('world');
    expect(screen.getByLabelText('Bold (Ctrl+B)')).toBeInTheDocument();
    expect(screen.getByLabelText('Save')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancel')).toBeInTheDocument();
  });

  it('Save with an unchanged body closes the editor without firing the mutation', async () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn
        channelId="ch-1"
        currentUserId="u-1"
      />,
    );
    fireEvent.click(screen.getByText('Edit'));
    await screen.findByLabelText('Message input');
    fireEvent.click(screen.getByLabelText('Save'));
    expect(editMutate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Save')).toBeNull();
  });

  it('Escape cancels the inline edit and restores the rendered message', async () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn
        channelId="ch-1"
        currentUserId="u-1"
      />,
    );
    fireEvent.click(screen.getByText('Edit'));
    const editor = await screen.findByLabelText('Message input');
    fireEvent.keyDown(editor, { key: 'Escape' });
    expect(screen.queryByTestId('inline-edit')).toBeNull();
  });
});
