import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageItem } from '@/components/chat/MessageItem';
import type { Message } from '@/types';

const editMutate = vi.fn();
const useAttachmentsBatchMock = vi.fn();

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: editMutate, isPending: false }),
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
  useAttachmentsBatch: (ids: string[]) => useAttachmentsBatchMock(ids),
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

function renderItem(overrides: Partial<Message> = {}, props: Partial<React.ComponentProps<typeof MessageItem>> = {}) {
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
          isOwn={true}
          channelId="ch-1"
          channelSlug="general"
          currentUserId="u-me"
          {...props}
        />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('MessageItem — copy-link fallback', () => {
  beforeEach(() => {
    editMutate.mockReset();
    useAttachmentsBatchMock.mockReset();
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), data: [] });
  });

  it('falls back to execCommand("copy") when clipboard.writeText rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('not allowed'));
    Object.assign(navigator, { clipboard: { writeText } });
    const execSpy = vi.fn(() => true);
    document.execCommand = execSpy as unknown as typeof document.execCommand;

    renderItem();
    fireEvent.click(screen.getByLabelText('Copy link to message'));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(execSpy).toHaveBeenCalledWith('copy');
    });
    // After copy, the menu item flips to "Link copied"
    await waitFor(() => {
      expect(screen.getByText(/Link copied/)).toBeInTheDocument();
    });
  });

  it('swallows the error when document.execCommand("copy") throws', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('not allowed'));
    Object.assign(navigator, { clipboard: { writeText } });
    document.execCommand = (() => {
      throw new Error('exec not allowed');
    }) as unknown as typeof document.execCommand;

    renderItem();
    fireEvent.click(screen.getByLabelText('Copy link to message'));
    // Should not throw and still flip to "Link copied"
    await waitFor(() => {
      expect(screen.getByText(/Link copied/)).toBeInTheDocument();
    });
  });

  it('builds the conversation deep link when no channel info is present', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderItem({}, {
      channelId: undefined,
      channelSlug: undefined,
      conversationId: 'conv-7',
    });
    fireEvent.click(screen.getByLabelText('Copy link to message'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toMatch(/\/conversation\/conv-7#msg-msg-1$/);
  });

  it('falls back to / link when neither channel nor conversation are set', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderItem({}, {
      channelId: undefined,
      channelSlug: undefined,
      conversationId: undefined,
    });
    fireEvent.click(screen.getByLabelText('Copy link to message'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toMatch(/\/#msg-msg-1$/);
  });

  it('uses channel ID when slug is missing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderItem({}, { channelId: 'ch-7', channelSlug: undefined });
    fireEvent.click(screen.getByLabelText('Copy link to message'));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toMatch(/\/channel\/ch-7#msg-msg-1$/);
  });
});

describe('MessageItem — edit no-op branches', () => {
  beforeEach(() => {
    editMutate.mockReset();
    useAttachmentsBatchMock.mockReset();
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), data: [] });
  });

  it('renders Loading… while attachments are being hydrated for an edit', () => {
    // Simulate "in flight" — map is empty but ids exist on the message.
    useAttachmentsBatchMock.mockReturnValue({ map: new Map(), data: undefined });
    renderItem({ body: 'with files', attachmentIDs: ['a-1', 'a-2'] });
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('mounts the editor once attachments hydrate (drafts populated)', async () => {
    useAttachmentsBatchMock.mockReturnValue({
      map: new Map([
        ['a-1', { id: 'a-1', filename: 'one.txt', contentType: 'text/plain', size: 1 }],
      ]),
      data: [{ id: 'a-1', filename: 'one.txt', contentType: 'text/plain', size: 1 }],
    });
    renderItem({ body: 'with files', attachmentIDs: ['a-1'] });
    fireEvent.click(screen.getByText('Edit'));
    expect(await screen.findByTestId('inline-edit')).toBeInTheDocument();
    // The chip from initialEditDrafts should be visible.
    expect(screen.getByText('one.txt')).toBeInTheDocument();
  });
});
