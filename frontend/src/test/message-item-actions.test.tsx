import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/useEmoji', () => ({
  useEmojis: () => ({ data: [] }),
  useEmojiMap: () => ({ data: {} }),
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
    body: 'hello',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

describe('MessageItem - hover bar and avatar', () => {
  it('renders Reply in thread button regardless of isOwn', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
      />,
    );
    expect(screen.getByLabelText('Reply in thread')).toBeInTheDocument();
    expect(screen.getByLabelText('Add reaction')).toBeInTheDocument();
  });

  it('shows edit/delete only when isOwn', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
      />,
    );
    expect(screen.queryByLabelText('More actions')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('shows edit/delete when isOwn', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={true}
      />,
    );
    expect(screen.getByLabelText('More actions')).toBeInTheDocument();
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('calls onReplyInThread when reply button is clicked', () => {
    const onReplyInThread = vi.fn();
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        isOwn={false}
        onReplyInThread={onReplyInThread}
      />,
    );
    fireEvent.click(screen.getByLabelText('Reply in thread'));
    expect(onReplyInThread).toHaveBeenCalledWith('msg-1');
  });

  it('renders without crashing when authorAvatarURL is provided', () => {
    // Radix Avatar's AvatarImage only mounts the <img> after onLoad fires,
    // so we can't reliably assert on the DOM in jsdom. Just make sure the
    // component renders with the prop set.
    renderWithProviders(
      <MessageItem
        message={makeMessage()}
        authorName="Alice"
        authorAvatarURL="https://example.com/a.png"
        isOwn={false}
      />,
    );
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });

  it('shows reply count link when replyCount > 0', () => {
    const onReplyInThread = vi.fn();
    renderWithProviders(
      <MessageItem
        message={makeMessage({ replyCount: 3 })}
        authorName="Alice"
        isOwn={false}
        onReplyInThread={onReplyInThread}
      />,
    );
    const replyLink = screen.getByText('3 replies');
    fireEvent.click(replyLink);
    expect(onReplyInThread).toHaveBeenCalledWith('msg-1');
  });

  it('shows singular "reply" when replyCount is 1', () => {
    renderWithProviders(
      <MessageItem
        message={makeMessage({ replyCount: 1 })}
        authorName="Alice"
        isOwn={false}
      />,
    );
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });
});
