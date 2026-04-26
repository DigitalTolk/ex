import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

const editMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: editMutate, isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
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

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void; variant?: string }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

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

  it('clicking Edit shows the full MessageInput composer prefilled', async () => {
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
    await waitFor(() => {
      expect(screen.getByTestId('inline-edit')).toBeInTheDocument();
    });
    const ta = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    expect(ta.value).toBe('hello *world*');
    // Formatting toolbar from MessageInput must be present
    expect(screen.getByLabelText('Bold (Ctrl+B)')).toBeInTheDocument();
    // Save and Cancel actions
    expect(screen.getByLabelText('Save')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancel')).toBeInTheDocument();
  });

  it('Save submits edit with new body and attachmentIDs', async () => {
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
    const ta = await screen.findByLabelText('Message input');
    fireEvent.change(ta, { target: { value: 'updated body' } });
    fireEvent.click(screen.getByLabelText('Save'));
    expect(editMutate).toHaveBeenCalledTimes(1);
    expect(editMutate.mock.calls[0][0]).toMatchObject({
      messageId: 'msg-1',
      body: 'updated body',
      attachmentIDs: [],
      channelId: 'ch-1',
    });
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
    const ta = await screen.findByLabelText('Message input');
    fireEvent.keyDown(ta, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('inline-edit')).toBeNull();
    });
  });

  it('shows a live preview while editing markdown', async () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ body: 'plain' })}
        authorName="Alice"
        isOwn
        channelId="ch-1"
        currentUserId="u-1"
      />,
    );
    fireEvent.click(screen.getByText('Edit'));
    const ta = await screen.findByLabelText('Message input');
    fireEvent.change(ta, { target: { value: '**bold**' } });
    expect(screen.getByTestId('message-input-preview').querySelector('strong')?.textContent).toBe('bold');
  });
});
