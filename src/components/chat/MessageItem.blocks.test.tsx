import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
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
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));
vi.mock('@/components/ui/dropdown-menu');

function renderItem(message: Message, props: Partial<Parameters<typeof MessageItem>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageItem message={message} channelId="ch-1" currentUserId="u-alice" {...props} />
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

const appCard = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  parentID: 'ch-1',
  authorID: 'webhook',
  webhookUsername: 'Release bot',
  body: 'api 1.42 is live https://ex.test/releases',
  createdAt: '2026-10-30T10:00:00Z',
  blocks: [
    { type: 'header', block_id: 'b1', text: { type: 'plain_text', text: 'api 1.42 is live' } },
    { type: 'actions', block_id: 'b2', elements: [{ type: 'button', action_id: 'ack', ex_action: 'ack', text: { type: 'plain_text', text: 'Acknowledge' } }] },
  ],
  ...over,
});

describe('MessageItem with blocks', () => {
  it('draws the blocks in place of their fallback text, with no link preview for it', () => {
    renderItem(appCard());
    expect(screen.getByTestId('message-blocks')).toHaveTextContent('api 1.42 is live');
    expect(screen.queryByText(/ex\.test\/releases/)).toBeNull();
    expect(screen.queryByTestId('unfurl-card')).toBeNull();
    expect(screen.getByTestId('block-button-ack')).not.toBeDisabled();
  });

  it('keeps the text, and draws the card’s blocks, when only a card has blocks', () => {
    renderItem(
      appCard({
        body: 'Platform sync: 2 items',
        blocks: undefined,
        messageAttachments: [
          { color: '#D97706', blocks: [{ type: 'actions', block_id: 'b1', elements: [{ type: 'button', action_id: 'vote', ex_action: 'vote', text: { type: 'plain_text', text: '+1' } }] }] },
        ],
      }),
    );
    expect(screen.getByText('Platform sync: 2 items')).toBeInTheDocument();
    expect(screen.getByTestId('message-rich-attachment')).toContainElement(screen.getByTestId('block-button-vote'));
    expect(screen.getByTestId('block-button-vote')).not.toBeDisabled();
  });

  it('shows the buttons but not live in a read-only chat, or while the message sends', () => {
    const view = renderItem(appCard(), { readOnly: true });
    expect(screen.getByTestId('block-button-ack')).toBeDisabled();
    view.unmount();
    renderItem(appCard({ pendingState: 'sending' }));
    expect(screen.getByTestId('block-button-ack')).toBeDisabled();
  });

  it('works in a conversation too', () => {
    renderItem(appCard(), { channelId: undefined, conversationId: 'dm-1' });
    expect(screen.getByTestId('block-button-ack')).not.toBeDisabled();
  });

  it('draws a message without blocks exactly as before', () => {
    renderItem(appCard({ blocks: undefined, body: 'plain text' }));
    expect(screen.queryByTestId('message-blocks')).toBeNull();
    expect(screen.getByText('plain text')).toBeInTheDocument();
  });
});
