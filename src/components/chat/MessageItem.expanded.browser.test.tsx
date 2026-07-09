import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageItem } from './MessageItem';
import type { Message } from '@/types';

// Expanded MessageItem browser coverage — exercises render paths the
// existing MessageItem.browser.test.tsx doesn't: system messages,
// deleted messages, reactions, attachments, pinned, edited, threads.

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
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

vi.mock('@/hooks/useUnfurl', () => ({
  useUnfurl: () => ({ data: undefined, isLoading: false }),
}));

function Wrap({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: 'u-1',
    body: 'Hello world',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

describe('MessageItem expanded browser', () => {
  it('renders a normal message body', async () => {
    const screen = await render(
      <Wrap>
        <MessageItem
          message={makeMessage()}
          authorName="Alice"
          isOwn={false}
          channelId="ch-1"
          currentUserId="u-2"
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('Hello world')).toBeVisible();
  });

  it('renders a system message with a muted appearance', async () => {
    const screen = await render(
      <Wrap>
        <MessageItem
          message={makeMessage({ system: true, body: 'Alice joined the channel' })}
          authorName="Alice"
          isOwn={false}
          channelId="ch-1"
          currentUserId="u-2"
        />
      </Wrap>,
    );
    await expect.element(screen.getByText(/joined the channel/)).toBeVisible();
  });

  it('renders a deleted-message placeholder when message.deleted is true', async () => {
    await render(
      <Wrap>
        <MessageItem
          message={makeMessage({ deleted: true, body: '' })}
          authorName="Alice"
          isOwn={false}
          channelId="ch-1"
          currentUserId="u-2"
        />
      </Wrap>,
    );
    // Common deleted-state copy variants.
    expect(document.body.textContent).toMatch(/deleted|removed/i);
  });

  it('renders an edited indicator when editedAt is set', async () => {
    const screen = await render(
      <Wrap>
        <MessageItem
          message={makeMessage({ editedAt: '2026-05-01T11:00:00Z' })}
          authorName="Alice"
          isOwn={true}
          channelId="ch-1"
          currentUserId="u-1"
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('Hello world')).toBeVisible();
    expect(document.body.textContent).toMatch(/edited/i);
  });

  it('renders reactions when present', async () => {
    await render(
      <Wrap>
        <MessageItem
          message={makeMessage({ reactions: { thumbsup: ['u-1', 'u-2'], heart: ['u-3'] } })}
          authorName="Alice"
          isOwn={false}
          channelId="ch-1"
          currentUserId="u-2"
        />
      </Wrap>,
    );
    // Reaction counts visible.
    expect(document.body.textContent).toContain('2');
    expect(document.body.textContent).toContain('1');
  });

  it('renders the pinned indicator when pinned=true', async () => {
    await render(
      <Wrap>
        <MessageItem
          message={makeMessage({ pinned: true })}
          authorName="Alice"
          isOwn={false}
          channelId="ch-1"
          currentUserId="u-2"
        />
      </Wrap>,
    );
    // The pin icon or aria-label "Pinned" is rendered.
    const pinIndicator = document.querySelector('[data-testid="pinned-indicator"], [aria-label*="inned" i]');
    expect(pinIndicator).not.toBeNull();
  });

  it('renders with a thread-reply teaser when replyCount > 0', async () => {
    await render(
      <Wrap>
        <MessageItem
          message={makeMessage({ replyCount: 4, lastReplyAt: '2026-05-01T12:00:00Z' })}
          authorName="Alice"
          isOwn={false}
          channelId="ch-1"
          currentUserId="u-2"
        />
      </Wrap>,
    );
    expect(document.body.textContent).toMatch(/4\s*repl|reply|replies/i);
  });

  it('renders a conversation message (parentType conversation)', async () => {
    const screen = await render(
      <Wrap>
        <MessageItem
          message={makeMessage({ parentType: 'conversation', parentID: 'conv-1', body: 'hi from DM' })}
          authorName="Bob"
          isOwn={false}
          conversationId="conv-1"
          currentUserId="u-2"
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('hi from DM')).toBeVisible();
  });
});
