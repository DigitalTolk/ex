import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageList } from '@/components/chat/MessageList';
import type { Message } from '@/types';

function renderWithProps(props: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  const messages: Message[] = [
    { id: 'm-1', parentID: 'ch-1', authorID: 'u-1', body: 'one', createdAt: new Date().toISOString() },
  ];
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageList
          pages={[{ items: messages }]}
          hasNextPage={false}
          isFetchingNextPage={false}
          isLoading={false}
          fetchNextPage={vi.fn()}
          currentUserId="u-me"
          channelId="ch-1"
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          {...props}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('MessageList bidirectional pagination', () => {
  it('renders the load-newer sentinel when hasPreviousPage is true', () => {
    renderWithProps({
      hasPreviousPage: true,
      isFetchingPreviousPage: false,
      fetchPreviousPage: vi.fn(),
    });
    expect(screen.getByTestId('message-list-load-newer')).toBeInTheDocument();
  });

  it('shows the loading label while fetching the previous (newer) page', () => {
    renderWithProps({
      hasPreviousPage: true,
      isFetchingPreviousPage: true,
      fetchPreviousPage: vi.fn(),
    });
    expect(screen.getByTestId('message-list-load-newer')).toHaveTextContent(/loading newer/i);
  });

  it('omits the sentinel when there are no newer messages to fetch', () => {
    renderWithProps({});
    expect(screen.queryByTestId('message-list-load-newer')).toBeNull();
  });
});
