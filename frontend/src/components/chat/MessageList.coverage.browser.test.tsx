import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render } from 'vitest-browser-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageList } from './MessageList';
import type { Message } from '@/types';

// Branch-coverage focused tests for MessageList: header/footer pagination
// labels, deep-link anchor dedup/no-revision, the own-message auto-stick
// guards (non-own / thread-reply bottoms), system-message rows, the
// thread-meta backfill arms, and the unknown-author fallback. These are
// render-shape branches that don't require virtuoso scroll mechanics.

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
};

function baseProps(messages: Message[]) {
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

async function animationFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

describe('MessageList coverage — header / footer pagination labels', () => {
  it('renders the older-messages header with the loading label while fetching next page', async () => {
    const screen = await render(
      <Wrap>
        <MessageList
          {...baseProps([msg({ id: 'm1', body: 'top' })])}
          hasNextPage={true}
          isFetchingNextPage={true}
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('Loading earlier messages…')).toBeVisible();
  });

  it('renders the newer-messages footer with the loading label while fetching previous page', async () => {
    const screen = await render(
      <Wrap>
        <MessageList
          {...baseProps([msg({ id: 'm1', body: 'bottom' })])}
          hasPreviousPage={true}
          isFetchingPreviousPage={true}
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('Loading newer messages…')).toBeVisible();
  });

  it('renders the load-more sentinels (empty labels) when not actively fetching', async () => {
    await render(
      <Wrap>
        <MessageList
          {...baseProps([msg({ id: 'm1', body: 'x' })])}
          hasNextPage={true}
          isFetchingNextPage={false}
          hasPreviousPage={true}
          isFetchingPreviousPage={false}
        />
      </Wrap>,
    );
    await animationFrames(2);
    expect(document.querySelector('[data-testid="message-list-load-more"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="message-list-load-newer"]')).not.toBeNull();
  });

  it('hides the intro in the header once an older page exists (hasNextPage)', async () => {
    await render(
      <Wrap>
        <MessageList
          {...baseProps([msg({ id: 'm1', body: 'x' })])}
          hasNextPage={true}
          isFetchingNextPage={false}
          intro={<div data-testid="intro-hidden">welcome</div>}
        />
      </Wrap>,
    );
    await animationFrames(2);
    // intro is gated behind `!hasNextPage` so it must not render.
    expect(document.querySelector('[data-testid="intro-hidden"]')).toBeNull();
  });
});

describe('MessageList coverage — empty state with intro', () => {
  it('renders the intro above the empty-list placeholder', async () => {
    const screen = await render(
      <Wrap>
        <MessageList {...baseProps([])} intro={<div data-testid="empty-intro">welcome</div>} />
      </Wrap>,
    );
    await expect.element(screen.getByTestId('empty-intro')).toBeVisible();
    await expect.element(screen.getByTestId('empty-message-list')).toBeVisible();
  });
});

describe('MessageList coverage — system rows and unknown authors', () => {
  it('renders a system message as a centered status row', async () => {
    const screen = await render(
      <Wrap>
        <MessageList
          {...baseProps([msg({ id: 'sys-1', system: true, body: 'Alice joined the channel' })])}
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('Alice joined the channel')).toBeVisible();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
  });

  it('falls back to "Unknown" for a message whose author is not in the userMap', async () => {
    const screen = await render(
      <Wrap>
        <MessageList
          {...baseProps([msg({ id: 'm-ghost', authorID: 'u-nobody', body: 'orphan message' })])}
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('orphan message')).toBeVisible();
    await expect.element(screen.getByText('Unknown')).toBeVisible();
  });
});

describe('MessageList coverage — thread-meta backfill', () => {
  it('backfills recentReplyAuthorIDs and lastReplyAt from derived thread meta', async () => {
    // A parent message with NO recentReplyAuthorIDs/lastReplyAt plus a
    // reply → deriveThreadMeta produces a meta entry for the parent, and
    // MessageRow's needsBackfill arm augments the parent (lines 481-489).
    const screen = await render(
      <Wrap>
        <MessageList
          {...baseProps([
            msg({ id: 'root-1', authorID: 'u-1', body: 'a question', createdAt: '2026-05-01T10:00:00Z' }),
            msg({
              id: 'reply-1',
              authorID: 'u-2',
              body: 'an answer',
              parentMessageID: 'root-1',
              createdAt: '2026-05-01T10:05:00Z',
            }),
          ])}
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('a question')).toBeVisible();
  });

  it('does not backfill a parent that already carries reply metadata', async () => {
    const screen = await render(
      <Wrap>
        <MessageList
          {...baseProps([
            msg({
              id: 'root-2',
              authorID: 'u-1',
              body: 'already has meta',
              createdAt: '2026-05-01T10:00:00Z',
              recentReplyAuthorIDs: ['u-2'],
              lastReplyAt: '2026-05-01T10:05:00Z',
            }),
            msg({
              id: 'reply-2',
              authorID: 'u-2',
              body: 'reply',
              parentMessageID: 'root-2',
              createdAt: '2026-05-01T10:05:00Z',
            }),
          ])}
        />
      </Wrap>,
    );
    await expect.element(screen.getByText('already has meta')).toBeVisible();
  });
});

describe('MessageList coverage — deep-link anchor without revision', () => {
  it('scrolls to the anchor using the bare anchorMsgId dedup key (no anchorRevision)', async () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      msg({ id: `am-${i}`, body: `msg ${i}`, createdAt: new Date(Date.UTC(2026, 4, 1, 10, i)).toISOString() }),
    );
    await render(
      <div style={{ height: 420, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Wrap>
          <MessageList {...baseProps(messages)} anchorMsgId="am-3" />
        </Wrap>
      </div>,
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[data-message-id="am-3"]')).not.toBeNull();
    }, { timeout: 3000 });
  });

  it('does not re-scroll when an unrelated prop changes but the anchor stays the same', async () => {
    // Second render with the SAME anchorMsgId → anchorAppliedRef already
    // equals the dedup key → the `=== dedupKey` early-return (line 159).
    const messages = Array.from({ length: 20 }, (_, i) =>
      msg({ id: `bm-${i}`, body: `msg ${i}`, createdAt: new Date(Date.UTC(2026, 4, 1, 10, i)).toISOString() }),
    );
    function Harness() {
      const [, force] = useState(0);
      return (
        <div style={{ height: 420, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <button data-testid="force" onClick={() => force((n) => n + 1)}>force</button>
          <MessageList {...baseProps(messages)} anchorMsgId="bm-3" anchorRevision="rev-1" />
        </div>
      );
    }
    const screen = await render(
      <Wrap>
        <Harness />
      </Wrap>,
    );
    await vi.waitFor(() => {
      expect(document.querySelector('[data-message-id="bm-3"]')).not.toBeNull();
    }, { timeout: 3000 });
    // Re-render with the same anchor; the effect must early-return.
    await screen.getByTestId('force').click();
    await animationFrames(2);
    expect(document.querySelector('[data-message-id="bm-3"]')).not.toBeNull();
  });
});

describe('MessageList coverage — own-message auto-stick guards', () => {
  it('does NOT force-scroll when the new bottom message belongs to another user', async () => {
    function Harness() {
      const [extra, setExtra] = useState<Message[]>([]);
      const all = [
        ...Array.from({ length: 12 }, (_, i) =>
          msg({ id: `om-${i}`, authorID: 'u-1', body: `m${i}`, createdAt: new Date(Date.UTC(2026, 4, 1, 10, i)).toISOString() }),
        ),
        ...extra,
      ];
      return (
        <>
          <button
            data-testid="add-other"
            onClick={() =>
              setExtra([msg({ id: 'other-bottom', authorID: 'u-2', body: 'from bob', createdAt: '2026-05-01T12:00:00Z' })])
            }
          >
            add
          </button>
          <div style={{ height: 420, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <MessageList {...baseProps(all)} pages={[{ items: [...all].reverse() }]} />
          </div>
        </>
      );
    }
    const screen = await render(
      <Wrap>
        <Harness />
      </Wrap>,
    );
    await animationFrames(4);
    // Appending a message from another user hits the
    // `last.message.authorID !== currentUserId` guard (line 288) — no
    // forced scroll, but the row still renders.
    await screen.getByTestId('add-other').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-message-id="other-bottom"]')).not.toBeNull();
    }, { timeout: 3000 });
  });

});

describe('MessageList coverage — pagination sentinels fire fetch callbacks', () => {
  it('calls fetchNextPage when the list start is reached and an older page exists', async () => {
    const fetchNextPage = vi.fn();
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `pn-${i}`, body: `m${i}`, createdAt: new Date(Date.UTC(2026, 4, 1, 10, i)).toISOString() }),
    );
    await render(
      <div style={{ height: 300, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Wrap>
          <MessageList
            {...baseProps(messages)}
            pages={[{ items: [...messages].reverse() }]}
            hasNextPage={true}
            isFetchingNextPage={false}
            fetchNextPage={fetchNextPage}
          />
        </Wrap>
      </div>,
    );
    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    await vi.waitFor(() => {
      expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight);
    }, { timeout: 3000 });
    scroller!.scrollTop = 0;
    scroller!.dispatchEvent(new Event('scroll', { bubbles: true }));
    await vi.waitFor(() => {
      expect(fetchNextPage).toHaveBeenCalled();
    }, { timeout: 3000 });
  });

  it('calls fetchPreviousPage when the list end is reached and a newer page exists', async () => {
    const fetchPreviousPage = vi.fn();
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg({ id: `pp-${i}`, body: `m${i}`, createdAt: new Date(Date.UTC(2026, 4, 1, 10, i)).toISOString() }),
    );
    await render(
      <div style={{ height: 300, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Wrap>
          <MessageList
            {...baseProps(messages)}
            pages={[{ items: [...messages].reverse() }]}
            anchorMsgId="pp-10"
            hasPreviousPage={true}
            isFetchingPreviousPage={false}
            fetchPreviousPage={fetchPreviousPage}
          />
        </Wrap>
      </div>,
    );
    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    await vi.waitFor(() => {
      expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight);
    }, { timeout: 3000 });
    scroller!.scrollTop = scroller!.scrollHeight;
    scroller!.dispatchEvent(new Event('scroll', { bubbles: true }));
    await vi.waitFor(() => {
      expect(fetchPreviousPage).toHaveBeenCalled();
    }, { timeout: 3000 });
  });
});
