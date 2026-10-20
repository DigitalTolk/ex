import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { userEvent } from 'vitest/browser';
import { MessageList } from './MessageList';
import { endReadSession, setUnreadAnchor } from '@/lib/read-position';
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
  usePendingMessageActions: () => ({ retry: vi.fn(), discard: vi.fn() }),
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
  useSetNoUnfurl: () => ({ mutate: vi.fn(), isPending: false }),
}));

// MessageItem now also calls useCreateReminder; this suite renders MessageList
// (hence MessageItem) without a QueryClientProvider, so stub the hook.
vi.mock('@/hooks/useActivity', () => ({
  useCreateReminder: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(() => Promise.resolve({})), isPending: false }),
}));
vi.mock('@/hooks/useMarkUnread', () => ({
  useMarkUnread: () => ({ mutate: vi.fn(), isPending: false }),
}));
// The list reads which threads are unread from the query cache.
vi.mock('@/hooks/useUnreadThreads', () => ({ useUnreadThreadIDs: () => new Set<string>() }));

// MessageItem also queries the viewer's thread watchers and the agent roster
// (react-query) — same deal: no QueryClientProvider here, so stub the hooks.
vi.mock('@/hooks/useAgents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAgents')>()),
  useParentWatchers: () => ({ data: [] }),
  useAgents: () => ({ data: [] }),
  useSkills: () => ({ data: [] }),
}));
vi.mock('@/hooks/useConnectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useConnectors')>()),
  useConnectors: () => ({ data: [] }),
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

  // The reported bug (phone): tapping the composer hid the newest message. The
  // app is sized to the space above the keyboard and the composer opens its
  // toolbar, both taking height from the list below it. Virtuoso follows only
  // a list within MESSAGE_LIST_AT_BOTTOM_THRESHOLD_PX of its very end, so a
  // reader a little short of it kept the scroll offset: the newest message
  // slid under the composer, and scrolling down to it dismissed the keyboard.
  describe('when the list is resized from below (the keyboard, the composer)', () => {
    function ResizedList({ anchorMsgId }: { anchorMsgId?: string }) {
      const [height, setHeight] = useState(600);
      const all = Array.from({ length: 30 }, (_, i) => msg(i));
      return (
        <>
          <button data-testid="keyboard-up" onClick={() => setHeight(300)}>up</button>
          <button data-testid="keyboard-down" onClick={() => setHeight(600)}>down</button>
          <div style={{ height, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
              anchorMsgId={anchorMsgId}
            />
          </div>
        </>
      );
    }
    const scrollerOf = () => document.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement;
    // The reader scrolling up to `px` short of the end: a wheel first, so the
    // list lets go of its initial settle at the bottom. Rows still measuring
    // (a loaded runner) can carry the list back to the end, so it is aimed
    // again until it has stayed there for a few frames.
    async function scrollUp(scroller: HTMLElement, px: number) {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -px, bubbles: true }));
      const deadline = performance.now() + 5000;
      for (let held = 0; held < 6; ) {
        if (performance.now() > deadline) throw new Error(`the list would not stay ${px}px short of the end`);
        if (Math.abs(distanceFromBottom(scroller) - px) > 1) {
          held = 0;
          scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - px;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
        } else {
          held += 1;
        }
        await animationFrames(1);
      }
    }
    // How far a message's bottom is above the view's (negative: cut off).
    function gapOf(scroller: HTMLElement, id: string) {
      const row = laidOutElement(`[data-message-id="${id}"]`);
      if (!row) return null;
      // `|| 0`: a sub-pixel gap rounds to -0, which toBe(0) refuses.
      return Math.round(scroller.getBoundingClientRect().bottom - row.getBoundingClientRect().bottom) || 0;
    }
    // The last message wholly in view.
    function bottomEdge(scroller: HTMLElement) {
      const view = scroller.getBoundingClientRect();
      const row = Array.from(scroller.querySelectorAll<HTMLElement>('[data-message-id]'))
        .filter((r) => {
          const box = r.getBoundingClientRect();
          return box.height > 0 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
        })
        .at(-1)!;
      return row.dataset.messageId!;
    }
    async function resize(screen: Awaited<ReturnType<typeof render>>, to: 'up' | 'down') {
      await screen.getByTestId(`keyboard-${to}`).click();
      await animationFrames(3);
    }

    it('keeps the newest message in view at the end of the list', async () => {
      const screen = await render(<ResizedList />);
      await settleAtBottom(scrollerOf());
      await resize(screen, 'up');
      expect(scrollerOf().clientHeight).toBeLessThanOrEqual(300);
      expect(distanceFromBottom(scrollerOf())).toBeLessThanOrEqual(2);
      expect(bottomEdge(scrollerOf())).toBe('m-29');
    });

    it('keeps the newest message where it was a few px short of the end', async () => {
      const screen = await render(<ResizedList />);
      await settleAtBottom(scrollerOf());
      await scrollUp(scrollerOf(), 12);
      expect(gapOf(scrollerOf(), 'm-29')).toBe(-12);
      await resize(screen, 'up');
      expect(gapOf(scrollerOf(), 'm-29')).toBe(-12);
    });

    it('keeps a reader a few messages up on what was at the bottom of the view', async () => {
      const screen = await render(<ResizedList />);
      await settleAtBottom(scrollerOf());
      await scrollUp(scrollerOf(), 400);
      const reading = bottomEdge(scrollerOf());
      expect(reading).not.toBe('m-29');
      const gap = gapOf(scrollerOf(), reading);
      await resize(screen, 'up');
      expect(gapOf(scrollerOf(), reading)).toBe(gap);
      // The keyboard going away again.
      await resize(screen, 'down');
      expect(gapOf(scrollerOf(), reading)).toBe(gap);
    });

    // Opened from a notification or a link: the list is anchored on that
    // message and does not follow the live tail.
    it('keeps the newest message in view in a chat opened at it', async () => {
      const screen = await render(<ResizedList anchorMsgId="m-29" />);
      await vi.waitFor(() => expect(laidOutElement('[data-message-id="m-29"]')).not.toBeNull(), { timeout: 3000 });
      await animationFrames(4);
      expect(bottomEdge(scrollerOf())).toBe('m-29');
      await resize(screen, 'up');
      expect(bottomEdge(scrollerOf())).toBe('m-29');
    });
  });

  // Messages, and the "New messages" line between them, use the list's whole
  // width, as in Slack: a narrower centred column (tried, and reverted) left
  // wide windows half empty and confused people.
  it('uses the whole width of a wide list for messages and the unread line', async () => {
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-3' });
    try {
      const all = Array.from({ length: 6 }, (_, i) => msg(i, { authorID: 'u-2' }));
      await render(
        <div style={{ height: 500, width: 1400, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
        </div>,
      );
      await vi.waitFor(() => expect(laidOutElement('[data-unread-divider]')).not.toBeNull(), { timeout: 3000 });
      const scroller = laidOutElement('[data-testid="virtuoso-scroller"]')!;
      const left = scroller.getBoundingClientRect().left;
      const right = left + scroller.clientWidth;
      // Within the rows' 16px side padding of both edges.
      for (const el of [laidOutElement('[data-unread-divider]')!, laidOutElement('[data-message-id="m-3"]')!]) {
        const box = el.getBoundingClientRect();
        expect(box.left - left).toBeLessThanOrEqual(17);
        expect(right - box.right).toBeLessThanOrEqual(17);
      }
    } finally {
      endReadSession('ch-1');
    }
  });

  // A grouped message (same author, no header) shows its time, and the
  // not-sent mark, in the avatar column beside its text — inside the list at
  // any width. (Placed left of the row instead, a narrow list cut it off at
  // its left edge.)
  describe("a grouped message's time", () => {
    async function renderAt(width: number) {
      const all = Array.from({ length: 6 }, (_, i) => msg(i, { authorID: 'u-1' }));
      await render(
        <div style={{ height: 500, width, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
            userMap={{ 'u-1': { displayName: 'Alice' } }}
          />
        </div>,
      );
      await vi.waitFor(() => expect(laidOutElement('[data-message-id="m-5"] [data-testid="group-time-gutter"]')).not.toBeNull(), { timeout: 3000 });
      const row = laidOutElement('[data-message-id="m-5"]')!.getBoundingClientRect();
      const gutter = laidOutElement('[data-message-id="m-5"] [data-testid="group-time-gutter"]')!.getBoundingClientRect();
      const list = laidOutElement('[data-testid="virtuoso-scroller"]')!.getBoundingClientRect();
      return { row, gutter, list };
    }

    it.each([700, 1200])('sits in the avatar column, left of the text, in a %ipx list', async (width) => {
      const { row, gutter, list } = await renderAt(width);
      const text = laidOutElement('[data-message-id="m-5"] [data-testid="group-time-gutter"] + div')!.getBoundingClientRect();
      expect(gutter.left).toBeGreaterThanOrEqual(Math.max(list.left, row.left));
      expect(gutter.right).toBeLessThanOrEqual(text.left);
    });
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

  // On a touch screen a press on the day line selected it ("Today" lit up
  // with selection handles); nothing outside a field is selectable there.
  it('on a touch screen the day line cannot be selected, while a field still can', async () => {
    const messages = Array.from({ length: 6 }, (_, index) => msg(index));
    const screen = await render(
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
          userMap={{ 'u-1': { displayName: 'Alice' }, 'u-2': { displayName: 'Bob' } }}
        />
        <div contentEditable suppressContentEditableWarning data-testid="field">
          Composer words
        </div>
      </div>,
    );
    const root = document.documentElement;
    const wasTouch = root.classList.contains('device-touch');
    root.classList.add('device-touch');
    try {
      await vi.waitFor(() => expect(document.querySelector('[data-testid="day-divider"] span')).not.toBeNull(), {
        timeout: 5000,
      });
      const label = document.querySelector('[data-testid="day-divider"] span') as HTMLElement;
      await userEvent.dblClick(label);
      expect(window.getSelection()?.toString() ?? '').toBe('');

      await userEvent.dblClick(screen.getByTestId('field'));
      expect(window.getSelection()?.toString().trim()).not.toBe('');
    } finally {
      if (!wasTouch) root.classList.remove('device-touch');
      window.getSelection()?.removeAllRanges();
    }
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
