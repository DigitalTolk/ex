import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));
vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/useEmoji', () => ({ useEmojis: () => ({ data: [] }), useEmojiMap: () => ({ data: {} }) }));
vi.mock('@/hooks/useAttachments', () => ({
  uploadAttachment: vi.fn(),
  useDeleteDraftAttachment: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  useAttachment: () => ({ data: undefined, isLoading: false }),
  useAttachmentsBatch: () => ({ map: new Map(), isLoading: false }),
}));
vi.mock('@/components/ui/dropdown-menu');

import { MessageItem } from '@/components/chat/MessageItem';
import { BlockList } from '@/components/chat/blocks/MessageBlocks';
import { MessageRichAttachments } from '@/components/chat/MessageRichAttachments';
import type { Message } from '@/types';

const ONCALL = '@[group-oncall|oncall]';

function wrap(children: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>,
  );
}

// A rich webhook's post, as the server stores it: the group tag is a mention
// token in the text, in the section people see, in a context line and in a
// card.
const radarPost = (over: Partial<Message> = {}): Message => ({
  id: 'msg-1',
  parentID: 'channel-1',
  authorID: 'webhook',
  webhookUsername: 'Radar',
  body: `${ONCALL} 3 merge requests are waiting`,
  createdAt: '2026-11-27T10:30:00Z',
  blocks: [
    { type: 'section', block_id: 'b1', text: { type: 'markdown', text: `${ONCALL} 3 merge requests are waiting` } },
    { type: 'context', block_id: 'b2', elements: [{ type: 'markdown', text: `owner @[user-1|Alice], paged ${ONCALL}` }] },
    { type: 'actions', block_id: 'b3', elements: [{ type: 'button', action_id: 'ack', ex_action: 'ack', text: { type: 'plain_text', text: 'Acknowledge' } }] },
  ],
  messageAttachments: [{ text: `card for ${ONCALL}`, fields: [{ title: 'Squad', value: ONCALL }] }],
  ...over,
});

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation((path: string) => {
    if (path === '/api/v1/users/user-1/usergroups') return Promise.resolve([{ id: 'group-oncall', handle: 'oncall' }]);
    if (path === '/api/v1/usergroups/group-oncall') {
      return Promise.resolve({ id: 'group-oncall', handle: 'oncall', name: 'On-call', description: '', disabled: false, memberIds: ['user-1'] });
    }
    return Promise.resolve([]);
  });
});

describe('MessageItem — user-group mentions in blocks and cards', () => {
  it("highlights a group tag in a section for the group's members and opens its card", async () => {
    wrap(<MessageItem message={radarPost()} channelId="channel-1" authorName="Radar" currentUserId="user-1" isOwn={false} />);
    const section = within(screen.getByTestId('message-blocks')).getAllByTestId('usergroup-mention-pill')[0];
    expect(section).toHaveTextContent('@oncall');
    await waitFor(() => expect(section).toHaveAttribute('data-mention-self', 'true'));
    fireEvent.click(section);
    expect(await screen.findByTestId('usergroup-card')).toHaveTextContent('On-call');
  });

  it('highlights group tags in a context line and in card text and fields', async () => {
    wrap(<MessageItem message={radarPost()} channelId="channel-1" authorName="Radar" currentUserId="user-1" isOwn={false} />);
    const context = within(screen.getByTestId('block-context')).getByTestId('usergroup-mention-pill');
    const card = within(screen.getByTestId('message-rich-attachment')).getAllByTestId('usergroup-mention-pill');
    expect(card).toHaveLength(2);
    for (const pill of [context, ...card]) {
      await waitFor(() => expect(pill).toHaveAttribute('data-mention-self', 'true'));
    }
  });

  it("highlights the reader's own @-mention in block text", async () => {
    wrap(<MessageItem message={radarPost()} channelId="channel-1" authorName="Radar" currentUserId="user-1" isOwn={false} />);
    const context = within(screen.getByTestId('block-context'));
    expect(context.getByTestId('mention-pill')).toHaveAttribute('data-mention-self', 'true');
    // The row's group lookups settle before the test ends.
    await waitFor(() => expect(context.getByTestId('usergroup-mention-pill')).toHaveAttribute('data-mention-self', 'true'));
  });

  it('draws card mentions for a message without blocks too', async () => {
    wrap(<MessageItem message={radarPost({ blocks: undefined })} channelId="channel-1" authorName="Radar" currentUserId="user-1" isOwn={false} />);
    const card = within(screen.getByTestId('message-rich-attachment')).getAllByTestId('usergroup-mention-pill');
    await waitFor(() => expect(card[0]).toHaveAttribute('data-mention-self', 'true'));
  });
});

describe('blocks and cards outside a message (the builder preview)', () => {
  it('draw a plain pill that opens nothing', () => {
    const post = radarPost();
    wrap(
      <>
        <BlockList blocks={post.blocks} />
        <MessageRichAttachments attachments={post.messageAttachments} />
      </>,
    );
    const pills = screen.getAllByTestId('usergroup-mention-pill');
    expect(pills).toHaveLength(4);
    for (const pill of pills) expect(pill).toHaveAttribute('data-mention-self', 'false');
    fireEvent.click(pills[0]);
    expect(screen.queryByTestId('usergroup-card')).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/v1/users/user-1/usergroups');
  });
});
