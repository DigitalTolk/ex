import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageList } from '@/components/chat/MessageList';
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

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

function renderList(messages: Message[]) {
  // pages are stored newest-first (the list reverses them); pass them
  // newest-first to mirror the real query shape.
  const newestFirst = [...messages].reverse();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageList
          pages={[{ items: newestFirst }]}
          hasNextPage={false}
          isFetchingNextPage={false}
          isLoading={false}
          fetchNextPage={vi.fn()}
          currentUserId="u-me"
          channelId="ch-1"
          userMap={{
            'u-1': { displayName: 'Alice' },
            'u-2': { displayName: 'Bob' },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('MessageList day-grouping divider', () => {
  it('inserts one divider per calendar day spanned', () => {
    const messages: Message[] = [
      {
        id: 'm-1', parentID: 'ch-1', authorID: 'u-1', body: 'one',
        createdAt: new Date(2026, 3, 24, 10, 0, 0).toISOString(),
      },
      {
        id: 'm-2', parentID: 'ch-1', authorID: 'u-2', body: 'two',
        createdAt: new Date(2026, 3, 25, 11, 0, 0).toISOString(),
      },
      {
        id: 'm-3', parentID: 'ch-1', authorID: 'u-1', body: 'three',
        createdAt: new Date(2026, 3, 25, 14, 0, 0).toISOString(),
      },
    ];
    renderList(messages);
    const dividers = screen.getAllByTestId('day-divider');
    // Two unique days (Apr 24, Apr 25) → two dividers.
    expect(dividers).toHaveLength(2);
  });

  it('does not insert a divider between two messages on the same day', () => {
    const same1 = new Date(2026, 3, 26, 9, 0, 0);
    const same2 = new Date(2026, 3, 26, 18, 30, 0);
    const messages: Message[] = [
      {
        id: 'a', parentID: 'ch-1', authorID: 'u-1', body: 'morning',
        createdAt: same1.toISOString(),
      },
      {
        id: 'b', parentID: 'ch-1', authorID: 'u-2', body: 'evening',
        createdAt: same2.toISOString(),
      },
    ];
    renderList(messages);
    expect(screen.getAllByTestId('day-divider')).toHaveLength(1);
  });

  it('renders the heading using the shared Mar 26th-style format', () => {
    const messages: Message[] = [
      {
        id: 'old', parentID: 'ch-1', authorID: 'u-1', body: 'old',
        createdAt: new Date(2025, 11, 31, 12, 0, 0).toISOString(),
      },
    ];
    renderList(messages);
    // Older year → includes the year per formatDayHeading.
    expect(screen.getByText('Dec 31st, 2025')).toBeInTheDocument();
  });
});
