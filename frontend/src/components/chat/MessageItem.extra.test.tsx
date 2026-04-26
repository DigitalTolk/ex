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
  it('enters edit mode when edit button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    await user.click(screen.getByText('Edit'));

    // Textarea should appear with the message body
    expect(screen.getByRole('textbox')).toHaveValue('Hello world');
    // Save and cancel buttons should appear
    expect(screen.getByLabelText('Save')).toBeInTheDocument();
    expect(screen.getByLabelText('Cancel')).toBeInTheDocument();
  });

  it('saves edited message when save button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
        channelId="ch-1"
      />,
    );

    await user.click(screen.getByText('Edit'));

    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'Updated message');
    await user.click(screen.getByLabelText('Save'));

    expect(mockEditMutate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', body: 'Updated message', channelId: 'ch-1' }),
      expect.anything(),
    );
  });

  it('cancels edit mode when cancel button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    await user.click(screen.getByText('Edit'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Cancel'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('saves on Enter key press (without shift)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
        channelId="ch-1"
      />,
    );

    await user.click(screen.getByText('Edit'));
    const textarea = screen.getByRole('textbox');
    await user.clear(textarea);
    await user.type(textarea, 'New body');
    await user.keyboard('{Enter}');

    expect(mockEditMutate).toHaveBeenCalled();
  });

  it('cancels on Escape key press', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    await user.click(screen.getByText('Edit'));
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not save if body is unchanged', async () => {
    mockEditMutate.mockClear();
    const user = userEvent.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    await user.click(screen.getByText('Edit'));
    // Body is already "Hello world", just click save
    await user.click(screen.getByLabelText('Save'));

    expect(mockEditMutate).not.toHaveBeenCalled();
  });
});

describe('MessageItem - delete', () => {
  it('calls deleteMessage.mutate when delete button is clicked', async () => {
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
    expect(mockDeleteMutate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', channelId: 'ch-1' }),
    );
  });
});
