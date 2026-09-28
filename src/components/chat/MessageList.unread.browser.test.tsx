import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { MessageList } from './MessageList';
import type { Attachment, Message } from '@/types';
import { act, useState, type ReactNode } from 'react';
import type { UnreadMarkerState } from '@/hooks/useUnreadMarker';
import { isListAtBottom, setListAtBottom } from '@/stores/read-position';

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

// MessageItem now also calls useCreateReminder; this suite renders MessageList
// (hence MessageItem) without a QueryClientProvider, so stub the hook.
vi.mock('@/hooks/useActivity', () => ({
  useCreateReminder: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(() => Promise.resolve({})), isPending: false }),
}));

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


function unreadState(patch: Partial<UnreadMarkerState> = {}): UnreadMarkerState {
  return { pending: false, count: 0, newCount: 0, markRead: vi.fn(), ...patch };
}

const baseProps = {
  hasNextPage: false,
  isFetchingNextPage: false,
  isLoading: false,
  fetchNextPage: vi.fn(),
  hasPreviousPage: false,
  isFetchingPreviousPage: false,
  fetchPreviousPage: vi.fn(),
  currentUserId: 'u-1',
  channelId: 'ch-1',
  channelSlug: 'general',
  userMap: { 'u-1': { displayName: 'Alice' }, 'u-2': { displayName: 'Bob' } },
};

function frame(children: ReactNode) {
  return <div style={{ height: 420, display: 'flex', flexDirection: 'column', minHeight: 0 }}>{children}</div>;
}

function scrollerEl(): HTMLElement {
  const scroller = document.querySelector('[data-testid="virtuoso-scroller"]') as HTMLElement | null;
  expect(scroller).not.toBeNull();
  return scroller!;
}

function isInViewport(el: Element, root: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const v = root.getBoundingClientRect();
  return r.bottom > v.top && r.top < v.bottom;
}

describe('MessageList unread chrome', () => {
  it('shows the banner while the New divider is far above, and Jump scrolls to it', async () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg(i));
    const unread = unreadState({ dividerMsgId: 'm-20', count: 180, since: messages[20].createdAt });
    const screen = await render(frame(
      <MessageList {...baseProps} pages={[{ items: [...messages].reverse() }]} unread={unread} />,
    ));
    const scroller = scrollerEl();
    await settleAtBottom(scroller);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="unread-banner"]')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('[data-testid="unread-banner"]')?.textContent).toContain('180 new messages');

    await screen.getByText('Jump to new messages').click();
    await vi.waitFor(() => {
      const divider = document.querySelector('[data-testid="unread-divider"]');
      expect(divider).not.toBeNull();
      expect(isInViewport(divider!, scroller)).toBe(true);
    }, { timeout: 3000 });
    expect(document.querySelector('[data-testid="unread-banner"]')).toBeNull();
  });

  it('shows the banner for a divider just above the viewport; Esc dismisses and marks read', async () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg(i));
    const unread = unreadState({ dividerMsgId: 'm-25', count: 15 });
    await render(frame(
      <MessageList {...baseProps} pages={[{ items: [...messages].reverse() }]} unread={unread} />,
    ));
    await settleAtBottom(scrollerEl());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="unread-banner"]')).not.toBeNull(), { timeout: 3000 });
    await browserAct(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await vi.waitFor(() => expect(unread.markRead).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="unread-banner"]')).toBeNull(), { timeout: 3000 });
  });

  it('the ✕ button marks read too', async () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg(i));
    const unread = unreadState({ dividerMsgId: 'm-25', count: 15 });
    const screen = await render(frame(
      <MessageList {...baseProps} pages={[{ items: [...messages].reverse() }]} unread={unread} />,
    ));
    await settleAtBottom(scrollerEl());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="unread-banner"]')).not.toBeNull(), { timeout: 3000 });
    await screen.getByLabelText('Mark as read').click();
    expect(unread.markRead).toHaveBeenCalledTimes(1);
  });

  it('no banner when the divider is already on screen', async () => {
    const messages = Array.from({ length: 6 }, (_, i) => msg(i));
    await render(frame(
      <MessageList {...baseProps} pages={[{ items: [...messages].reverse() }]} unread={unreadState({ dividerMsgId: 'm-4', count: 2 })} />,
    ));
    await vi.waitFor(() => expect(document.querySelector('[data-testid="unread-divider"]')).not.toBeNull(), { timeout: 3000 });
    await animationFrames(6);
    expect(document.querySelector('[data-testid="unread-banner"]')).toBeNull();
  });

  // Once the reader has SEEN the divider, scrolling it back out of view (in
  // either direction) never brings the banner back this visit.
  it('keeps the divider "seen" after it scrolls out of view', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => msg(i));
    await render(frame(
      <MessageList {...baseProps} pages={[{ items: [...messages].reverse() }]} unread={unreadState({ dividerMsgId: 'm-57', count: 3 })} />,
    ));
    const scroller = scrollerEl();
    await settleAtBottom(scroller);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="unread-divider"]')).not.toBeNull(), { timeout: 3000 });
    await animationFrames(4);
    // Scroll to the top: the divider is now BELOW the viewport (still mounted
    // in the overscan), then far out of the rendered window.
    await browserAct(async () => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await animationFrames(6);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(document.querySelector('[data-testid="unread-banner"]')).toBeNull();
  });

  it('pending (first unread not loaded): Jump pages back until the divider lands', async () => {
    const fetchNextPage = vi.fn();
    const messages = Array.from({ length: 40 }, (_, i) => msg(i + 100));
    function Harness() {
      const [loaded, setLoaded] = useState(false);
      const older = loaded ? Array.from({ length: 20 }, (_, i) => msg(i)) : [];
      const all = [...older, ...messages];
      return (
        <>
          <button data-testid="load-older" onClick={() => setLoaded(true)}>older</button>
          {frame(
            <MessageList
              {...baseProps}
              hasNextPage={!loaded}
              fetchNextPage={fetchNextPage}
              pages={[{ items: [...all].reverse() }]}
              unread={loaded ? unreadState({ dividerMsgId: 'm-10', count: 50 }) : unreadState({ pending: true, count: 50 })}
            />,
          )}
        </>
      );
    }
    const screen = await render(<Harness />);
    await settleAtBottom(scrollerEl());
    await vi.waitFor(() => expect(document.querySelector('[data-testid="unread-banner"]')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('[data-testid="unread-banner"]')?.textContent).toContain('50 new messages');
    await screen.getByText('Jump to new messages').click();
    await vi.waitFor(() => expect(fetchNextPage).toHaveBeenCalled(), { timeout: 3000 });
    await screen.getByTestId('load-older').click();
    await vi.waitFor(() => {
      const divider = document.querySelector('[data-testid="unread-divider"]');
      expect(divider).not.toBeNull();
      expect(isInViewport(divider!, scrollerEl())).toBe(true);
    }, { timeout: 3000 });
  });

  it('pending with no older pages left scrolls to the top', async () => {
    const messages = Array.from({ length: 40 }, (_, i) => msg(i));
    const screen = await render(frame(
      <MessageList {...baseProps} pages={[{ items: [...messages].reverse() }]} unread={unreadState({ pending: true, count: 3 })} />,
    ));
    const scroller = scrollerEl();
    await settleAtBottom(scroller);
    await screen.getByText('Jump to new messages').click();
    await vi.waitFor(() => expect(scroller.scrollTop).toBeLessThan(50), { timeout: 3000 });
  });

  it('a Jump that cannot find the first unread stops after a bounded number of pages', async () => {
    const fetchNextPage = vi.fn();
    const messages = Array.from({ length: 40 }, (_, i) => msg(i));
    function Harness() {
      const [fetching, setFetching] = useState(false);
      return frame(
        <MessageList
          {...baseProps}
          hasNextPage
          isFetchingNextPage={fetching}
          fetchNextPage={() => {
            fetchNextPage();
            // Each fetch "completes" without ever surfacing the divider.
            setFetching(true);
            setTimeout(() => setFetching(false), 10);
          }}
          pages={[{ items: [...messages].reverse() }]}
          unread={unreadState({ pending: true, count: 500 })}
        />,
      );
    }
    const screen = await render(<Harness />);
    const scroller = scrollerEl();
    await settleAtBottom(scroller);
    await screen.getByText('Jump to new messages').click();
    await vi.waitFor(() => expect(scroller.scrollTop).toBeLessThan(50), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Bounded: 5 page-backs, not a crawl through the whole history.
    // (Virtuoso's own startReached at the top may add at most one more.)
    expect(fetchNextPage.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(fetchNextPage.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('a deep-link window with newer pages unloaded is never "at the live tail"', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i));
    await render(frame(
      <MessageList
        {...baseProps}
        hasPreviousPage
        pages={[{ items: [...messages].reverse() }]}
        anchorMsgId="m-15"
        unread={unreadState()}
      />,
    ));
    await vi.waitFor(() => expect(document.querySelector('[data-message-id="m-15"]')).not.toBeNull(), { timeout: 3000 });
    const scroller = scrollerEl();
    await browserAct(async () => {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await animationFrames(2);
    });
    expect(isListAtBottom('ch-1')).toBe(false);
  });

  it('an anchor window that fits the viewport counts as at the bottom', async () => {
    setListAtBottom('ch-1', false);
    const messages = Array.from({ length: 3 }, (_, i) => msg(i));
    await render(frame(
      <MessageList {...baseProps} pages={[{ items: [...messages].reverse() }]} anchorMsgId="m-1" unread={unreadState()} />,
    ));
    await vi.waitFor(() => expect(isListAtBottom('ch-1')).toBe(true), { timeout: 3000 });
  });

  it('shows the new-messages pill while scrolled up and jumps to the latest', async () => {
    const messages = Array.from({ length: 60 }, (_, i) => msg(i));
    const screen = await render(frame(
      <MessageList {...baseProps} pages={[{ items: [...messages].reverse() }]} unread={unreadState({ newCount: 2 })} />,
    ));
    const scroller = scrollerEl();
    await settleAtBottom(scroller);
    // Let the post-mount stick-to-bottom chase settle before scrolling away.
    await animationFrames(8);
    await new Promise((resolve) => setTimeout(resolve, 1300));
    // Rows measured in after the first settle can grow the list (WebKit):
    // park the reader at the real bottom again before asserting "no pill".
    await browserAct(async () => {
      await settleAtBottom(scroller);
    });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="new-messages-pill"]')).toBeNull(), { timeout: 3000 });
    await browserAct(async () => {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 600);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await animationFrames(2);
    });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="new-messages-pill"]')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('[data-testid="new-messages-pill"]')?.textContent).toContain('2 new messages');
    await screen.getByTestId('new-messages-pill').click();
    await vi.waitFor(() => expect(distanceFromBottom(scroller)).toBeLessThan(8), { timeout: 3000 });
    await browserAct(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await animationFrames(2);
    });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="new-messages-pill"]')).toBeNull(), { timeout: 3000 });
  });

  it('a divider below the viewport (arrived while scrolled up) does not show the banner', async () => {
    const messages = Array.from({ length: 200 }, (_, i) => msg(i));
    await render(frame(
      <MessageList
        {...baseProps}
        pages={[{ items: [...messages].reverse() }]}
        anchorMsgId="m-10"
        unread={unreadState({ dividerMsgId: 'm-190', count: 10 })}
      />,
    ));
    await vi.waitFor(() => expect(document.querySelector('[data-message-id="m-10"]')).not.toBeNull(), { timeout: 3000 });
    await animationFrames(8);
    expect(document.querySelector('[data-testid="unread-banner"]')).toBeNull();
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

function distanceFromBottom(scroller: HTMLElement) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}
