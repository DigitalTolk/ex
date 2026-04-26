import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

const mockEditMutate = vi.fn();
const mockDeleteMutate = vi.fn();
const mockReactMutate = vi.fn();

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: mockEditMutate, isPending: false }),
  useDeleteMessage: () => ({ mutate: mockDeleteMutate, isPending: false }),
  useToggleReaction: () => ({ mutate: mockReactMutate, isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));

// Mock the dropdown menu so menu items render directly in jsdom
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dropdown-content">{children}</div>,
  DropdownMenuItem: ({ children, onClick, ...rest }: { children: React.ReactNode; onClick?: () => void; variant?: string; 'aria-label'?: string }) => (
    <button data-testid="dropdown-item" onClick={onClick} aria-label={rest['aria-label']}>{children}</button>
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

describe('MessageItem', () => {
  it('renders author name and message body', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice Johnson"
        isOwn={false}
      />,
    );

    expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('shows formatted time', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ createdAt: '2026-04-24T14:05:00Z' })}
        authorName="Alice"
        isOwn={false}
      />,
    );

    // The time element should be present with the dateTime attribute
    const timeEl = document.querySelector('time[datetime="2026-04-24T14:05:00Z"]');
    expect(timeEl).toBeInTheDocument();
  });

  it('does NOT show "(edited)" when editedAt is undefined', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ editedAt: undefined })}
        authorName="Alice"
        isOwn={false}
      />,
    );

    expect(screen.queryByText('(edited)')).not.toBeInTheDocument();
  });

  it('shows "(edited)" when editedAt is set', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ editedAt: '2026-04-24T11:00:00Z' })}
        authorName="Alice"
        isOwn={false}
      />,
    );

    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });

  it('shows edit/delete buttons for own messages', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );

    // Edit/Delete are now inside a dropdown — open the "More actions" menu first
    await user.click(screen.getByLabelText('More actions'));
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('does not show edit/delete buttons for other people\'s messages', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Bob"
        isOwn={false}
      />,
    );

    // The "More actions" menu is rendered for everyone now (Copy link
    // and Pin work on any message), but Edit/Delete remain own-only.
    expect(screen.getByLabelText('More actions')).toBeInTheDocument();
    // Mocked DropdownMenuContent renders all items inline — we check
    // by presence of the labels themselves.
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    // Pin and Copy link are still available.
    expect(screen.getByLabelText('Pin message')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy link to message')).toBeInTheDocument();
  });

  it('renders author initials in avatar', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice Johnson"
        isOwn={false}
      />,
    );

    expect(screen.getByText('AJ')).toBeInTheDocument();
  });

  it('renders reactions when present', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-1', 'user-2'], '🎉': ['user-3'] } })}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    const list = screen.getByRole('list', { name: /reactions/i });
    expect(list).toBeInTheDocument();
    expect(screen.getByText('👍')).toBeInTheDocument();
    expect(screen.getByText('🎉')).toBeInTheDocument();
  });

  it('shows reaction count', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-1', 'user-2', 'user-3'] } })}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    const reactionBtn = screen.getByRole('listitem');
    expect(reactionBtn).toHaveTextContent('👍');
    expect(reactionBtn).toHaveTextContent('3');
  });

  it('marks own reaction as pressed', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-1'] } })}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    expect(screen.getByRole('listitem')).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking existing reaction toggles it', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    mockReactMutate.mockClear();
    renderWithProviders(
      <MessageItem
        message={makeMessage({ reactions: { '👍': ['user-1'] } })}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await user.click(screen.getByRole('listitem'));
    expect(mockReactMutate).toHaveBeenCalledWith({
      messageId: 'msg-1',
      emoji: '👍',
      channelId: 'channel-1',
      conversationId: undefined,
    });
  });

  it('opens emoji picker from reaction button and selecting an emoji calls toggle', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    mockReactMutate.mockClear();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        channelId="channel-1"
        currentUserId="user-1"
      />,
    );
    await user.click(screen.getByLabelText('Add reaction'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByLabelText('React with :tada:'));
    expect(mockReactMutate).toHaveBeenCalledWith({
      messageId: 'msg-1',
      emoji: ':tada:',
      channelId: 'channel-1',
      conversationId: undefined,
    });
  });

  it('does not render reactions row when no reactions', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        currentUserId="user-1"
      />,
    );
    expect(screen.queryByRole('list', { name: /reactions/i })).not.toBeInTheDocument();
  });
});
