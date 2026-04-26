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
    const editor = screen.getByLabelText('Message input');
    // The WYSIWYG editor is contentEditable — initialBody is converted to
    // HTML on mount; verify the visible text matches the source markdown
    // content (italic markers turn into an <em>, but textContent is flat).
    expect(editor.textContent ?? '').toContain('hello');
    expect(editor.textContent ?? '').toContain('world');
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
    const editor = await screen.findByLabelText('Message input');
    editor.textContent = 'updated body';
    fireEvent.input(editor);
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
    const editor = await screen.findByLabelText('Message input');
    fireEvent.keyDown(editor, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('inline-edit')).toBeNull();
    });
  });
});
