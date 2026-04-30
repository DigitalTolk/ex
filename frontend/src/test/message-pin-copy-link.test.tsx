import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

const setPinnedMutate = vi.fn();
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: setPinnedMutate, isPending: false }),
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
  DropdownMenuTrigger: ({ children, ...props }: { children: React.ReactNode; [k: string]: unknown }) => (
    <button {...props}>{children}</button>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick, ...rest }: { children: React.ReactNode; onClick?: () => void; 'aria-label'?: string }) => (
    <button onClick={onClick} aria-label={rest['aria-label']}>{children}</button>
  ),
}));

function renderItem(overrides: Partial<Message> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const message: Message = {
    id: 'msg-1',
    parentID: 'ch-1',
    authorID: 'u-author',
    body: 'Hi',
    createdAt: '2026-04-26T10:30:00Z',
    ...overrides,
  };
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageItem
          message={message}
          authorName="Author"
          isOwn={false}
          channelId="ch-1"
          channelSlug="general"
          currentUserId="u-me"
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setPinnedMutate.mockReset();
});

describe('MessageItem — pin and copy-link actions', () => {
  it('shows Pin in the menu and pins on click', () => {
    renderItem();
    const pin = screen.getByLabelText('Pin message');
    fireEvent.click(pin);
    expect(setPinnedMutate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', pinned: true, channelId: 'ch-1' }),
    );
  });

  it('shows Unpin when message is already pinned, plus a Pinned indicator', () => {
    renderItem({ pinned: true, pinnedBy: 'u-author', pinnedAt: '2026-04-26T11:00:00Z' });
    expect(screen.getByLabelText('Unpin message')).toBeInTheDocument();
    expect(screen.getByLabelText('Pinned')).toBeInTheDocument();
  });

  it('Copy link writes the channel slug deep-link with #msg-{id}', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    renderItem();
    fireEvent.click(screen.getByLabelText('Copy link to message'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const link = writeText.mock.calls[0][0] as string;
    expect(link).toMatch(/\/channel\/general#msg-msg-1$/);
  });

  it('Copy link of a thread reply includes ?thread=ROOT so it opens the thread on load', async () => {
    // The host view only auto-opens the thread panel when ?thread=ROOT
    // is present, so a bare hash URL would scroll to the reply but
    // leave the thread closed.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    renderItem({ id: 'reply-1', parentMessageID: 'root-1' });
    fireEvent.click(screen.getByLabelText('Copy link to message'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const link = writeText.mock.calls[0][0] as string;
    expect(link).toMatch(/\/channel\/general\?thread=root-1#msg-reply-1$/);
  });

  it('renders a stable id="msg-{id}" anchor for the deep link target', () => {
    renderItem();
    expect(document.getElementById('msg-msg-1')).not.toBeNull();
  });
});
