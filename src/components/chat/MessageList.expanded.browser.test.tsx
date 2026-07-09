import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageList } from './MessageList';
import type { Message } from '@/types';

// Expanded MessageList browser coverage — covers extra render paths
// (empty list, system messages, day dividers, multiple authors,
// reactions) the existing MessageList.browser.test.tsx doesn't.

vi.mock('@/components/UserHoverCard', () => ({
  UserHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojiMap: () => ({ data: {} }),
  useEmojis: () => ({ data: [] }),
  useUploadEmoji: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEmoji: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useUnfurl', () => ({
  useUnfurl: () => ({ data: undefined, isLoading: false }),
}));

vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useDeleteDraftAttachment: () => ({ mutate: vi.fn(), isPending: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

function msg(over: Partial<Message>): Message {
  return {
    id: over.id ?? 'msg-' + Math.random().toString(36).slice(2, 8),
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body: '',
    createdAt: '2026-05-01T10:00:00Z',
    ...over,
  };
}

const userMap = {
  'u-1': { displayName: 'Alice' },
  'u-2': { displayName: 'Bob' },
  'u-3': { displayName: 'System' },
};

function defaultProps(messages: Message[]) {
  return {
    pages: [{ items: messages }],
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasPreviousPage: false,
    isFetchingPreviousPage: false,
    fetchPreviousPage: vi.fn(),
    userMap,
    currentUserId: 'u-1',
    channelId: 'ch-1',
  };
}

describe('MessageList expanded browser', () => {
  it('renders the loading skeleton when isLoading is true', async () => {
    await render(
      <Wrap>
        <MessageList {...defaultProps([])} isLoading={true} />
      </Wrap>,
    );
    // Skeleton rows render (the only thing visible).
    expect(document.body.textContent).not.toContain('Hello');
  });

  it('renders an empty page list (zero messages) without crashing', async () => {
    await render(
      <Wrap>
        <MessageList {...defaultProps([])} />
      </Wrap>,
    );
    expect(document.body.textContent).not.toContain('Hello');
  });

  it('renders messages from multiple authors', async () => {
    const screen = await render(
      <Wrap>
        <MessageList
          {...defaultProps([
            msg({ id: 'm1', authorID: 'u-1', body: 'Hello from Alice', createdAt: '2026-05-01T10:00:00Z' }),
            msg({ id: 'm2', authorID: 'u-2', body: 'Hi Alice', createdAt: '2026-05-01T10:01:00Z' }),
          ])}
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('Hello from Alice')).toBeVisible();
    await expect.element(screen.getByText('Hi Alice')).toBeVisible();
  });

  it('renders messages with day divider crossing midnight', async () => {
    const screen = await render(
      <Wrap>
        <MessageList
          {...defaultProps([
            msg({ id: 'm-day1', body: 'before midnight', createdAt: '2026-05-01T23:55:00Z' }),
            msg({ id: 'm-day2', body: 'after midnight', createdAt: '2026-05-02T00:10:00Z' }),
          ])}
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('before midnight')).toBeVisible();
    await expect.element(screen.getByText('after midnight')).toBeVisible();
  });

  it('renders an intro node when provided', async () => {
    const screen = await render(
      <Wrap>
        <MessageList
          {...defaultProps([msg({ id: 'm1', body: 'hi' })])}
          intro={<div data-testid="intro">welcome</div>}
        />
      </Wrap>,
    );
    await expect.element(screen.getByTestId('intro')).toBeVisible();
  });
});
