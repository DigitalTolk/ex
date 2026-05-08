import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageList } from './MessageList';
import type { Attachment, Message } from '@/types';
import type { ReactNode } from 'react';
import { expectPaintedAtCenter } from '@/test/browser-assertions';

const browserMedia = vi.hoisted(() => ({
  imageURL: `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700"><rect width="900" height="700" fill="#16a34a"/></svg>',
  )}`,
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
      const [ready, setReady] = React.useState(false);
      React.useEffect(() => {
        const timer = window.setTimeout(() => setReady(true), 80);
        return () => window.clearTimeout(timer);
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
    const messages = Array.from({ length: 24 }, (_, index) => msg(index));
    messages.push(msg(99, {
      body: `Bottom media message\n\n![inline](${browserMedia.imageURL} =320x249)\n\nhttps://example.com/story`,
      attachmentIDs: ['att-1'],
    }));

    await render(
      <div style={{ height: 420, display: 'flex', minHeight: 0 }}>
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

    await vi.waitFor(() => {
      const image = document.querySelector('[data-testid="message-image-thumb"]');
      expect(image).not.toBeNull();
      expectPaintedAtCenter(image!);
    });

    await vi.waitFor(() => {
      const distanceFromBottom = scroller!.scrollHeight - scroller!.scrollTop - scroller!.clientHeight;
      expect(distanceFromBottom).toBeLessThan(4);
    });
  });
});
