import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageList } from './MessageList';
import type { Attachment, Message } from '@/types';
import { act, useState, type ReactNode } from 'react';

const browserMedia = vi.hoisted(() => ({
  imageURL: `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700"><rect width="900" height="700" fill="#16a34a"/></svg>',
  )}`,
  thumbnailURL: `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="498"><rect width="640" height="498" fill="#2563eb"/></svg>',
  )}`,
  attachmentsReady: false,
  attachmentListeners: new Set<() => void>(),
}));

vi.mock('@/components/UserHoverCard', () => ({
  UserHoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
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
  useUnfurl: () => ({
    data: {
      url: 'https://example.com/story',
      title: 'Example story',
      description: 'Preview text',
      image: browserMedia.imageURL,
    },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useAttachments', async () => {
  const React = await import('react');
  const attachment: Attachment = {
    id: 'att-1',
    sha256: 'sha',
    filename: 'large.png',
    contentType: 'image/png',
    size: 1000,
    url: browserMedia.imageURL,
    thumbnailURL: browserMedia.thumbnailURL,
    squareThumbnailURL: browserMedia.thumbnailURL,
    width: 900,
    height: 700,
    createdBy: 'u-1',
    createdAt: '2026-05-08T10:00:00.000Z',
  };
  return {
    uploadAttachment: vi.fn(),
    useAttachment: () => ({ data: undefined, isLoading: false }),
    useDeleteDraftAttachment: () => ({ mutate: vi.fn(), isPending: false }),
    useAttachmentsBatch: (ids: string[]) => {
      const [ready, setReady] = React.useState(browserMedia.attachmentsReady);
      React.useEffect(() => {
        const listener = () => setReady(browserMedia.attachmentsReady);
        browserMedia.attachmentListeners.add(listener);
        return () => {
          browserMedia.attachmentListeners.delete(listener);
        };
      }, []);
      return {
        map: ready && ids.includes('att-1') ? new Map([['att-1', attachment]]) : new Map(),
        isLoading: !ready,
      };
    },
  };
});

function msg(index: number, patch: Partial<Message> = {}): Message {
  return {
    id: `m-${index}`,
    parentID: 'ch-1',
    parentType: 'channel',
    authorID: index % 2 === 0 ? 'u-1' : 'u-2',
    body: `Message ${index}`,
    createdAt: new Date(Date.UTC(2026, 4, 8, 10, index)).toISOString(),
    ...patch,
  };
}

describe('MessageList browser behavior', () => {
  it('stays pinned to bottom when rendered message media changes measured height', async () => {
    browserMedia.attachmentsReady = false;
    browserMedia.attachmentListeners.clear();

    const messages = Array.from({ length: 24 }, (_, index) => msg(index));
    messages.push(msg(99, {
      body: `Bottom media message\n\n![inline](${browserMedia.imageURL} =320x249)\n\nhttps://example.com/story`,
      attachmentIDs: ['att-1'],
    }));

    await render(
      <div style={{ height: 420, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <MessageList
          pages={[{ items: [...messages].reverse() }]}
          hasNextPage={false}
          isFetchingNextPage={false}
          isLoading={false}
          fetchNextPage={vi.fn()}
          hasPreviousPage={false}
          isFetchingPreviousPage={false}
          fetchPreviousPage={vi.fn()}
          currentUserId="u-1"
          channelId="ch-1"
          channelSlug="general"
          userMap={{
            'u-1': { displayName: 'Alice' },
            'u-2': { displayName: 'Bob' },
          }}
        />
      </div>,
    );

    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    await settleAtBottom(scroller!);

    await browserAct(async () => {
      browserMedia.attachmentsReady = true;
      browserMedia.attachmentListeners.forEach((listener) => listener());
      await animationFrames(4);
    });

    await vi.waitFor(() => {
      const thumb = laidOutElement('[data-testid="message-image-thumb"]');
      expect(thumb).not.toBeNull();
      const image = thumb!.querySelector('img') as HTMLImageElement | null;
      expect(image).not.toBeNull();
      expect(image!.src).toBe(browserMedia.thumbnailURL);
      expect(image!.complete).toBe(true);
      expect(image!.naturalWidth).toBeGreaterThan(0);
      expect(image!.naturalHeight).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // The re-stick is a chain of image-load → ResizeObserver → Virtuoso
    // followOutput scroll. Rather than passively waiting for it to settle — which
    // under full-suite CPU load on the slowest (webkit) project can starve and
    // time out even though it re-sticks reliably — actively pump animation frames
    // so the chain gets CPU ticks each iteration, with a generous deadline kept
    // comfortably under the 45s testTimeout.
    const deadline = Date.now() + 30000;
    while (distanceFromBottom(scroller!) >= 4 && Date.now() < deadline) {
      await animationFrames(2);
    }
    expect(distanceFromBottom(scroller!)).toBeLessThan(4);

    const thumb = laidOutElement('[data-testid="message-image-thumb"]');
    expect(thumb).not.toBeNull();
  });

  it('does not yank a mobile reader back to bottom when media height changes after scrolling up', async () => {
    browserMedia.attachmentsReady = false;
    browserMedia.attachmentListeners.clear();

    const messages = Array.from({ length: 80 }, (_, index) => msg(index));
    messages.push(msg(199, {
      body: `Bottom media message\n\n![inline](${browserMedia.imageURL} =320x249)\n\nhttps://example.com/story`,
      attachmentIDs: ['att-1'],
    }));

    await render(
      <div style={{ height: 420, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <MessageList
          pages={[{ items: [...messages].reverse() }]}
          hasNextPage={false}
          isFetchingNextPage={false}
          isLoading={false}
          fetchNextPage={vi.fn()}
          hasPreviousPage={false}
          isFetchingPreviousPage={false}
          fetchPreviousPage={vi.fn()}
          currentUserId="u-1"
          channelId="ch-1"
          channelSlug="general"
          userMap={{
            'u-1': { displayName: 'Alice' },
            'u-2': { displayName: 'Bob' },
          }}
        />
      </div>,
    );

    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    await settleAtBottom(scroller!);
    await animationFrames(8);
    await new Promise((resolve) => setTimeout(resolve, 1300));

    await browserAct(async () => {
      scroller!.scrollTop = Math.max(0, scroller!.scrollHeight - scroller!.clientHeight - 220);
      scroller!.dispatchEvent(new Event('scroll', { bubbles: true }));
      await animationFrames(1);
    });

    await vi.waitFor(() => {
      expect(distanceFromBottom(scroller!)).toBeGreaterThan(40);
    }, { timeout: 3000 });
    const distanceBeforeMedia = distanceFromBottom(scroller!);

    await browserAct(async () => {
      browserMedia.attachmentsReady = true;
      browserMedia.attachmentListeners.forEach((listener) => listener());
      await animationFrames(6);
    });

    await vi.waitFor(() => {
      const thumb = laidOutElement('[data-testid="message-image-thumb"]');
      expect(thumb).not.toBeNull();
    }, { timeout: 3000 });

    await animationFrames(4);
    const distanceAfterMedia = distanceFromBottom(scroller!);
    expect(distanceAfterMedia).toBeGreaterThan(40);
    expect(distanceAfterMedia).toBeGreaterThanOrEqual(distanceBeforeMedia - 8);
  });

  it('auto-sticks to the bottom when the local user appends a new message', async () => {
    function Harness() {
      const [extra, setExtra] = useState<Message[]>([]);
      const all = [...Array.from({ length: 12 }, (_, i) => msg(i)), ...extra];
      return (
        <>
          <button
            data-testid="add-own"
            onClick={() => setExtra([msg(500, { authorID: 'u-1', createdAt: '2026-05-08T12:00:00Z' })])}
          >
            add
          </button>
          <div style={{ height: 420, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <MessageList
              pages={[{ items: [...all].reverse() }]}
              hasNextPage={false}
              isFetchingNextPage={false}
              isLoading={false}
              fetchNextPage={vi.fn()}
              hasPreviousPage={false}
              isFetchingPreviousPage={false}
              fetchPreviousPage={vi.fn()}
              currentUserId="u-1"
              channelId="ch-1"
              channelSlug="general"
              userMap={{ 'u-1': { displayName: 'Alice' }, 'u-2': { displayName: 'Bob' } }}
            />
          </div>
        </>
      );
    }
    const screen = await render(<Harness />);
    const scroller = document.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null;
    expect(scroller).not.toBeNull();
    await settleAtBottom(scroller!);
    // Appending a fresh own message at the bottom triggers the auto-stick
    // effect (bottom changed, author is self, not a thread reply).
    await screen.getByTestId('add-own').click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-message-id="m-500"]')).not.toBeNull();
    }, { timeout: 3000 });
  });

  it('scrolls to and highlights the deep-link anchor message', async () => {
    const messages = Array.from({ length: 30 }, (_, index) => msg(index));
    await render(
      <div style={{ height: 420, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <MessageList
          pages={[{ items: [...messages].reverse() }]}
          hasNextPage={false}
          isFetchingNextPage={false}
          isLoading={false}
          fetchNextPage={vi.fn()}
          hasPreviousPage={false}
          isFetchingPreviousPage={false}
          fetchPreviousPage={vi.fn()}
          currentUserId="u-1"
          channelId="ch-1"
          channelSlug="general"
          anchorMsgId="m-5"
          anchorRevision="r1"
          userMap={{ 'u-1': { displayName: 'Alice' }, 'u-2': { displayName: 'Bob' } }}
        />
      </div>,
    );
    // The anchor logic finds m-5, scrolls it into view, and highlights it —
    // exercising the anchor index/dedup/highlight branches.
    await vi.waitFor(() => {
      expect(document.querySelector('[data-message-id="m-5"]')).not.toBeNull();
    }, { timeout: 3000 });
  });
});

async function browserAct(callback: () => void | Promise<void>) {
  const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => callback());
  } finally {
    actGlobal.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

async function settleAtBottom(scroller: HTMLElement) {
  await vi.waitFor(() => {
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  }, { timeout: 3000 });

  for (let i = 0; i < 3; i += 1) {
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    await animationFrames(1);
  }
}

async function animationFrames(count: number) {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function laidOutElement(selector: string): HTMLElement | null {
  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
  return elements.find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) ?? null;
}

function distanceFromBottom(scroller: HTMLElement) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}
