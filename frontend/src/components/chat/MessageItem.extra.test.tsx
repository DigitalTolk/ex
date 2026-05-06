import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

const mockEditMutate = vi.fn();
const mockDeleteMutate = vi.fn();

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteMessage: () => ({ mutate: mockDeleteMutate, isPending: false }),
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

// Mock the dropdown menu so menu items render directly in jsdom
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
    parentID: 'channel-1',
    authorID: 'user-1',
    body: 'Hello world',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

describe('MessageItem - editing', () => {
  it('enters inline edit mode on desktop when Edit is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    await user.click(screen.getByText('Edit'));

    expect(screen.getByLabelText('Message input').textContent).toContain('Hello world');
    expect(screen.getByLabelText('Save')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancel')).toBeInTheDocument();
  });

  it('does not save unchanged inline edits', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    await user.click(screen.getByText('Edit'));
    await user.click(screen.getByLabelText('Save'));
    expect(mockEditMutate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Save')).toBeNull();
  });
});

describe('MessageItem - delete', () => {
  it('opens a confirmation dialog and only deletes after confirm', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
        channelId="ch-1"
      />,
    );

    // Clicking the menu item alone must NOT delete — it opens the modal.
    await user.click(screen.getByText('Delete'));
    expect(mockDeleteMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('message-delete-confirm')).toBeInTheDocument();

    // Confirming fires the mutation.
    await user.click(screen.getByTestId('message-delete-confirm-confirm'));
    expect(mockDeleteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', channelId: 'ch-1' }),
    );
  });

  it('Cancel keeps the message and closes the dialog', async () => {
    mockDeleteMutate.mockClear();
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
        channelId="ch-1"
      />,
    );

    await user.click(screen.getByText('Delete'));
    await user.click(screen.getByTestId('message-delete-confirm-cancel'));
    expect(mockDeleteMutate).not.toHaveBeenCalled();
  });
});
