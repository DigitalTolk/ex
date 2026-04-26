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
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
}));

const sampleMsg: Message = {
  id: 'm-1',
  parentID: 'ch-1',
  authorID: 'u-1',
  body: 'hi',
  createdAt: '2026-04-26T10:00:00Z',
};

function renderList(opts: { hasNextPage: boolean; intro?: React.ReactNode; isLoading?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageList
          pages={[{ items: [sampleMsg] }]}
          hasNextPage={opts.hasNextPage}
          isFetchingNextPage={false}
          isLoading={opts.isLoading ?? false}
          fetchNextPage={vi.fn()}
          currentUserId="u-me"
          channelId="ch-1"
          userMap={{ 'u-1': { displayName: 'Alice' } }}
          intro={opts.intro}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('MessageList intro placement', () => {
  it('renders the intro when hasNextPage is false (we have reached the start)', () => {
    renderList({ hasNextPage: false, intro: <div data-testid="my-intro">INTRO</div> });
    expect(screen.getByTestId('my-intro')).toBeInTheDocument();
  });

  it('hides the intro while older messages are still pageable', () => {
    renderList({ hasNextPage: true, intro: <div data-testid="my-intro">INTRO</div> });
    expect(screen.queryByTestId('my-intro')).toBeNull();
  });

  it('renders no intro element when none is supplied', () => {
    renderList({ hasNextPage: false });
    expect(screen.queryByTestId('conversation-intro')).toBeNull();
  });
});
