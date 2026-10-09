import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  usePendingMessageActions: () => ({ retry: vi.fn(), discard: vi.fn() }),
}));
vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
}));
vi.mock('@/components/ui/dropdown-menu');

function renderItem(over: Partial<Message> = {}, props: { threadHasNew?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const message: Message = {
    id: 'msg-1',
    parentID: 'channel-1',
    authorID: 'user-1',
    body: 'Rollout at nine',
    createdAt: '2026-10-07T10:30:00Z',
    ...over,
  };
  const result = render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageItem message={message} authorName="Alice" isOwn currentUserId="user-1" {...props} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
  // The hover toolbar mounts on hover (MessageItem): hover the row so the
  // tests can reach its actions the way a pointer user does.
  const row = result.container.querySelector('[data-message-id]');
  if (row) fireEvent.mouseEnter(row);
  return result;
}

describe('MessageItem — optimistic rows', () => {
  it('a message still sending has greyed text and nothing else — no icon, no actions yet', () => {
    const { container } = renderItem({ id: 'pending-n1', clientNonce: 'n1', pendingState: 'sending' });
    expect(container.querySelector('.prose-message')!.className).toContain('text-muted-foreground');
    expect(screen.getByRole('status')).toHaveTextContent('Sending'); // for screen readers only
    expect(screen.queryByTestId('message-failed')).toBeNull();
    expect(screen.queryByLabelText('Message actions')).toBeNull();
  });

  it('a failed message keeps its text in full colour, marked "Not sent" with Try again / Delete', () => {
    const { container } = renderItem({ id: 'pending-n1', clientNonce: 'n1', pendingState: 'failed' });
    expect(container.querySelector('.prose-message')!.className).not.toContain('text-muted-foreground');
    expect(screen.getByTestId('message-failed')).toHaveTextContent('Not sent');
    expect(screen.getByLabelText('Try sending again')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message actions')).toBeNull();
  });

  it('a grouped row: sending leaves the time gutter alone; a failure marks it over the hidden time', () => {
    const qc = new QueryClient();
    const ui = (pendingState: Message['pendingState']) => (
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <MessageItem
            message={{ id: 'pending-n2', parentID: 'channel-1', authorID: 'user-1', body: 'and one more', createdAt: '2026-10-07T10:31:00Z', clientNonce: 'n2', pendingState }}
            authorName="Alice"
            isOwn
            currentUserId="user-1"
            firstInGroup={false}
          />
        </BrowserRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(ui('sending'));
    const gutter = screen.getByTestId('group-time-gutter');
    expect(gutter.querySelector('time')!.className).not.toContain('invisible');
    expect(gutter.querySelector('[data-testid="message-failed"]')).toBeNull();
    rerender(ui('failed'));
    expect(gutter).toContainElement(screen.getByTestId('message-failed'));
    // Kept at opacity 0 as well, so it can't flash while fading out.
    expect(gutter.querySelector('time')!.className).toContain('invisible opacity-0');
  });

  it('a confirmed grouped row reveals its time on hover', () => {
    const qc = new QueryClient();
    const { container } = render(
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <MessageItem
            message={{ id: 'm-2', parentID: 'channel-1', authorID: 'user-1', body: 'and one more', createdAt: '2026-10-07T10:31:00Z' }}
            authorName="Alice"
            isOwn
            currentUserId="user-1"
            firstInGroup={false}
          />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    const time = screen.getByTestId('group-time-gutter').querySelector('time')!;
    expect(time.className).toContain('opacity-0');
    fireEvent.mouseEnter(container.querySelector('[data-message-id]')!);
    expect(time.className).toContain('opacity-100');
  });

  it('a confirmed message has its actions and no mark', () => {
    const { container } = renderItem();
    expect(container.querySelector('[data-pending]')).toBeNull();
    expect(screen.getByLabelText('Message actions')).toBeInTheDocument();
    expect(screen.queryByTestId('message-sending')).toBeNull();
  });

  it('its reply bar says when the thread has unread replies', () => {
    renderItem({ replyCount: 2, recentReplyAuthorIDs: ['user-2'] }, { threadHasNew: true });
    expect(screen.getByTestId('thread-action-new')).toBeInTheDocument();
  });
});
