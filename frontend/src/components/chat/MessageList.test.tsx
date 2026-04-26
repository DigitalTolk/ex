import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageList } from './MessageList';
import type { Message } from '@/types';

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
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

const defaultProps = {
  hasNextPage: false,
  isFetchingNextPage: false,
  isLoading: false,
  fetchNextPage: vi.fn(),
  currentUserId: 'user-1',
  channelId: 'channel-1',
  userMap: {
    'user-1': { displayName: 'Alice' },
    'user-2': { displayName: 'Bob' },
  } as Record<string, { displayName: string; avatarURL?: string }>,
};

describe('MessageList', () => {
  it('shows "No messages yet" when empty', () => {
    renderWithProviders(
      <MessageList {...defaultProps} pages={[{ items: [] }]} />,
    );

    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it('renders messages in chronological order (reversed from API)', () => {
    const pages = [
      {
        items: [
          makeMessage({ id: 'msg-2', body: 'Second message', createdAt: '2026-04-24T10:31:00Z', authorID: 'user-2' }),
          makeMessage({ id: 'msg-1', body: 'First message', createdAt: '2026-04-24T10:30:00Z', authorID: 'user-1' }),
        ],
      },
    ];

    renderWithProviders(
      <MessageList {...defaultProps} pages={pages} />,
    );

    const firstMsg = screen.getByText('First message');
    const secondMsg = screen.getByText('Second message');
    expect(firstMsg).toBeInTheDocument();
    expect(secondMsg).toBeInTheDocument();

    // After reversing, First message should come before Second message in DOM
    const allParagraphs = screen.getAllByText(/message$/);
    expect(allParagraphs[0]).toHaveTextContent('First message');
    expect(allParagraphs[1]).toHaveTextContent('Second message');
  });

  it('shows date separators', () => {
    const pages = [
      {
        items: [
          makeMessage({ id: 'msg-2', body: 'Yesterday msg', createdAt: '2026-04-23T10:00:00Z' }),
          makeMessage({ id: 'msg-1', body: 'Today msg', createdAt: '2026-04-24T10:00:00Z' }),
        ],
      },
    ];

    renderWithProviders(
      <MessageList {...defaultProps} pages={pages} />,
    );

    // The separator elements should have role="separator"
    const separators = screen.getAllByRole('separator');
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  it('shows "Load earlier messages" when hasNextPage is true', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
      />,
    );

    expect(screen.getByText('Load earlier messages')).toBeInTheDocument();
  });

  it('does not show "Load earlier messages" when hasNextPage is false', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={false}
      />,
    );

    expect(screen.queryByText('Load earlier messages')).not.toBeInTheDocument();
  });

  it('shows loading skeletons when isLoading is true', () => {
    const { container } = renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[]}
        isLoading={true}
      />,
    );

    // Skeleton elements should be present
    const skeletons = container.querySelectorAll('[class*="animate-pulse"], [data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows "Loading..." when fetching next page', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
        isFetchingNextPage={true}
      />,
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('uses userMap to display author names', () => {
    const pages = [
      {
        items: [
          makeMessage({ id: 'msg-1', authorID: 'user-2', body: 'Hi from Bob' }),
        ],
      },
    ];

    renderWithProviders(
      <MessageList {...defaultProps} pages={pages} />,
    );

    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders system messages inline without avatar/edit controls', () => {
    const pages = [
      {
        items: [
          makeMessage({
            id: 'sys-1',
            authorID: 'system',
            body: 'Alice joined the channel',
            system: true,
          }),
        ],
      },
    ];

    renderWithProviders(<MessageList {...defaultProps} pages={pages} />);

    // Body text appears
    expect(screen.getByText('Alice joined the channel')).toBeInTheDocument();
    // No edit/delete buttons since it's a system message
    expect(screen.queryByLabelText('Edit message')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delete message')).not.toBeInTheDocument();
  });
});
