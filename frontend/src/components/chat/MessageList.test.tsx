import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageList } from './MessageList';
import type { Message } from '@/types';

vi.mock('@/hooks/useMessages', () => ({
  useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleReaction: () => ({ mutate: vi.fn(), isPending: false }),
  useSetPinned: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BrowserRouter>{ui}</BrowserRouter>
    </QueryClientProvider>,
  );
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    parentID: 'channel-1',
    authorID: 'user-1',
    body: 'Hello world',
    createdAt: '2026-04-24T10:30:00Z',
    ...overrides,
  };
}

const defaultProps = {
  hasNextPage: false,
  isFetchingNextPage: false,
  isLoading: false,
  fetchNextPage: vi.fn(),
  currentUserId: 'user-1',
  channelId: 'channel-1',
  userMap: {
    'user-1': { displayName: 'Alice' },
    'user-2': { displayName: 'Bob' },
  } as Record<string, { displayName: string; avatarURL?: string }>,
};

// Stubs out IntersectionObserver and exposes a `fire()` so tests can
// trigger the observer callback synchronously. The first observed
// element wins (we only observe one sentinel here).
function installFakeIntersectionObserver(): {
  fire: () => void;
  restore: () => void;
} {
  const original = globalThis.IntersectionObserver;
  let trigger: (() => void) | null = null;
  class FakeObserver {
    private cb: IntersectionObserverCallback;
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element) {
      trigger = () =>
        this.cb(
          [{ isIntersecting: true, target: el } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
    }
    disconnect() { trigger = null; }
    unobserve() {}
    takeRecords() { return []; }
    root = null;
    rootMargin = '';
    thresholds: number[] = [];
  }
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
  return {
    fire: () => trigger?.(),
    restore: () => {
      globalThis.IntersectionObserver = original;
    },
  };
}

describe('MessageList', () => {
  it('shows "No messages yet" when empty', () => {
    renderWithProviders(
      <MessageList {...defaultProps} pages={[{ items: [] }]} />,
    );

    expect(screen.getByText(/no messages yet/i)).toBeInTheDocument();
  });

  it('renders messages in chronological order (reversed from API)', () => {
    const pages = [
      {
        items: [
          makeMessage({ id: 'msg-2', body: 'Second message', createdAt: '2026-04-24T10:31:00Z', authorID: 'user-2' }),
          makeMessage({ id: 'msg-1', body: 'First message', createdAt: '2026-04-24T10:30:00Z', authorID: 'user-1' }),
        ],
      },
    ];

    renderWithProviders(
      <MessageList {...defaultProps} pages={pages} />,
    );

    const firstMsg = screen.getByText('First message');
    const secondMsg = screen.getByText('Second message');
    expect(firstMsg).toBeInTheDocument();
    expect(secondMsg).toBeInTheDocument();

    // After reversing, First message should come before Second message in DOM
    const allParagraphs = screen.getAllByText(/message$/);
    expect(allParagraphs[0]).toHaveTextContent('First message');
    expect(allParagraphs[1]).toHaveTextContent('Second message');
  });

  it('preserves chronological order across multiple pages', () => {
    // Regression: useChannelMessages used to .reverse() the pages array
    // in `select`, then MessageList did flatMap().reverse() — across
    // multiple pages this inverted the *batch* order so newest-batch
    // messages appeared above older-batch messages, producing day
    // dividers like "Today → Yesterday → Today" interleaved.
    // The hook now returns pages in API order (newest batch first,
    // items newest-first within each page); MessageList's single
    // `.reverse()` then yields a clean chronological flat list.
    const pages = [
      // Newest batch (page 1)
      {
        items: [
          makeMessage({ id: 'm-6', body: 'today-late', createdAt: '2026-04-28T18:00:00Z' }),
          makeMessage({ id: 'm-5', body: 'today-mid', createdAt: '2026-04-28T12:00:00Z' }),
          makeMessage({ id: 'm-4', body: 'today-early', createdAt: '2026-04-28T08:00:00Z' }),
        ],
      },
      // Older batch (page 2)
      {
        items: [
          makeMessage({ id: 'm-3', body: 'yesterday-late', createdAt: '2026-04-27T22:00:00Z' }),
          makeMessage({ id: 'm-2', body: 'yesterday-mid', createdAt: '2026-04-27T14:00:00Z' }),
          makeMessage({ id: 'm-1', body: 'yesterday-early', createdAt: '2026-04-27T09:00:00Z' }),
        ],
      },
    ];

    renderWithProviders(<MessageList {...defaultProps} pages={pages} />);

    const bodies = screen
      .getAllByText(/^(yesterday|today)-(early|mid|late)$/)
      .map((el) => el.textContent);
    expect(bodies).toEqual([
      'yesterday-early',
      'yesterday-mid',
      'yesterday-late',
      'today-early',
      'today-mid',
      'today-late',
    ]);

    // Exactly one divider per calendar day, in chronological order.
    const dividers = screen.getAllByTestId('day-divider');
    expect(dividers).toHaveLength(2);
  });

  it('shows date separators', () => {
    const pages = [
      {
        items: [
          makeMessage({ id: 'msg-2', body: 'Yesterday msg', createdAt: '2026-04-23T10:00:00Z' }),
          makeMessage({ id: 'msg-1', body: 'Today msg', createdAt: '2026-04-24T10:00:00Z' }),
        ],
      },
    ];

    renderWithProviders(
      <MessageList {...defaultProps} pages={pages} />,
    );

    // The separator elements should have role="separator"
    const separators = screen.getAllByRole('separator');
    expect(separators.length).toBeGreaterThanOrEqual(1);
  });

  it('renders an auto-load sentinel when hasNextPage is true', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
      />,
    );

    expect(screen.getByTestId('message-list-load-more')).toBeInTheDocument();
  });

  it('does not render the sentinel when hasNextPage is false', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={false}
      />,
    );

    expect(screen.queryByTestId('message-list-load-more')).not.toBeInTheDocument();
  });

  it('shows "Loading earlier messages…" status while fetching the next page', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
        isFetchingNextPage={true}
      />,
    );
    expect(screen.getByText(/Loading earlier messages/i)).toBeInTheDocument();
  });

  it('shows loading skeletons when isLoading is true', () => {
    const { container } = renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[]}
        isLoading={true}
      />,
    );

    // Skeleton elements should be present
    const skeletons = container.querySelectorAll('[class*="animate-pulse"], [data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows the loading status text when fetching next page', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
        isFetchingNextPage={true}
      />,
    );

    expect(screen.getByText(/Loading earlier messages/i)).toBeInTheDocument();
  });

  it('force-checks for older messages when the user wheel-scrolls up past the top', () => {
    const refetch = vi.fn();
    const { container } = renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        refetch={refetch}
      />,
    );
    const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
    scroller.scrollTop = 0;

    // Below the threshold (80px) — no fire yet.
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 }));
    expect(refetch).not.toHaveBeenCalled();

    // Cumulative wheel-up crosses the threshold → fire once.
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }));
    expect(refetch).toHaveBeenCalledTimes(1);

    // Rate-limit: another big wheel-up immediately after must not
    // re-trigger (3-second window).
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT force-check when the user is not at the top, or when scrolling down', () => {
    const refetch = vi.fn();
    const { container } = renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        refetch={refetch}
      />,
    );
    const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;

    // Not at top — overscroll doesn't apply.
    scroller.scrollTop = 200;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -300 }));
    expect(refetch).not.toHaveBeenCalled();

    // At top, but scrolling DOWN — natural scroll, not overscroll.
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 300 }));
    expect(refetch).not.toHaveBeenCalled();
  });

  it('snaps to the bottom on initial messages render so the user starts on the newest', () => {
    // Regression: visiting a channel was landing the user at the
    // OLDEST message (top of the list) because there was no test
    // exercising the actual scrollTop adjustment. jsdom doesn't lay
    // out, so we mock scrollHeight, render with 0 messages first, then
    // re-render with messages — the bottom-stick layoutEffect fires
    // when allMessages.length transitions 0 → N and must set
    // scrollTop to scrollHeight.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <MessageList {...defaultProps} {...props} />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const { rerender, container } = render(wrap({ pages: [{ items: [] }] }));
    const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
    expect(scroller.scrollTop).toBe(0);

    Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
    rerender(
      wrap({
        pages: [
          {
            items: [
              makeMessage({ id: 'm-2', body: 'newer', createdAt: '2026-04-24T10:31:00Z' }),
              makeMessage({ id: 'm-1', body: 'older', createdAt: '2026-04-24T10:30:00Z' }),
            ],
          },
        ],
      }),
    );
    expect(scroller.scrollTop).toBe(1500);
  });

  it('persistent bottom-stick STOPS re-pinning once the user scrolls up to read older content', () => {
    let resizeCallback: (() => void) | null = null;
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; resizeCallback = cb; }
      observe() {}
      disconnect() { resizeCallback = null; }
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <MessageList {...defaultProps} {...props} />
          </BrowserRouter>
        </QueryClientProvider>
      );

      const { rerender, container } = render(wrap({ pages: [{ items: [] }] }));
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
      Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });
      Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
      rerender(wrap({ pages: [{ items: [makeMessage({ id: 'm-1' })] }] }));
      expect(scroller.scrollTop).toBe(1500);

      // Reader scrolls up past the 120px "at bottom" window.
      // distanceFromBottom = 1500 - 200 - 600 = 700.
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event('scroll'));

      // Async content settles. The observer must NOT slam them back
      // to the bottom — they're intentionally reading older content.
      Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true });
      resizeCallback?.();
      expect(scroller.scrollTop).toBe(200);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('keeps the user pinned to the bottom on a fresh mount as content keeps settling — page-refresh scenario', () => {
    // Regression: refreshing the page (full mount, no warm cache)
    // landed the user at the OLDEST message because the bottom-stick
    // ResizeObserver only ran for ~4 seconds, then disconnected.
    // Slow-loading attachments / unfurls / avatar URLs took longer
    // than that, so once they settled the user was no longer at the
    // bottom. The observer is now persistent for the channel
    // session, gated on wasAtBottomRef so it never yanks a reader
    // who has scrolled up.
    let resizeCallback: (() => void) | null = null;
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; resizeCallback = cb; }
      observe() {}
      disconnect() { resizeCallback = null; }
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <MessageList {...defaultProps} {...props} />
          </BrowserRouter>
        </QueryClientProvider>
      );

      // Fresh mount with empty pages, exactly as on a page refresh
      // before the messages query has resolved.
      const { rerender, container } = render(wrap({ pages: [{ items: [] }] }));
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
      Object.defineProperty(scroller, 'clientHeight', { value: 600, configurable: true });

      // Messages arrive. Initial scrollHeight is small (placeholder
      // attachment slots still 0px), so the synchronous pin lands
      // somewhere short of "real bottom".
      Object.defineProperty(scroller, 'scrollHeight', { value: 800, configurable: true });
      rerender(wrap({ pages: [{ items: [makeMessage({ id: 'm-1' })] }] }));
      expect(scroller.scrollTop).toBe(800);

      // Slow attachment load #1 — three seconds in.
      Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
      resizeCallback?.();
      expect(scroller.scrollTop).toBe(1500);

      // Slow attachment load #2 — six seconds in. The old
      // implementation would have disconnected at 4s and missed
      // this; the user would be stranded at 1500 while real bottom
      // is 2400.
      Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true });
      resizeCallback?.();
      expect(scroller.scrollTop).toBe(2400);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('keeps re-pinning to the bottom while async content settles (avatars, attachments) on initial load', () => {
    // Regression: visiting a channel was landing the user near the
    // top because async content (avatars, attachments, unfurls)
    // resized inside the viewport AFTER the initial synchronous
    // scrollTop write. The bottom-stick now wires a ResizeObserver
    // for a few seconds so subsequent layout shifts re-pin to the
    // bottom and the user lands cleanly on the newest message.
    let resizeCallback: (() => void) | null = null;
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; resizeCallback = cb; }
      observe() {}
      disconnect() { resizeCallback = null; }
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <MessageList {...defaultProps} {...props} />
          </BrowserRouter>
        </QueryClientProvider>
      );

      const { rerender, container } = render(wrap({ pages: [{ items: [] }] }));
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;

      // First render with messages — scrollTop snaps to scrollHeight.
      Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
      rerender(wrap({ pages: [{ items: [makeMessage({ id: 'm-1', body: 'a' })] }] }));
      expect(scroller.scrollTop).toBe(1000);

      // Async content (e.g., an attachment image) loads, growing the
      // inner content. ResizeObserver fires; we must re-pin to the
      // new scrollHeight so the user doesn't drift up.
      Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
      resizeCallback?.();
      expect(scroller.scrollTop).toBe(1500);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('snaps to the bottom even when the channel has cached data already (no isLoading transition)', () => {
    // The other variant: useInfiniteQuery served cached pages
    // synchronously, so MessageList renders messages on its first
    // commit. Effect must fire and set scrollTop to scrollHeight on
    // that first paint, not require a 0→N transition.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Harness = () => (
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <MessageList
            {...defaultProps}
            pages={[
              {
                items: [
                  makeMessage({ id: 'm-2', body: 'newer' }),
                  makeMessage({ id: 'm-1', body: 'older' }),
                ],
              },
            ]}
          />
        </BrowserRouter>
      </QueryClientProvider>
    );

    // Patch Element.prototype.scrollHeight before render so the
    // useLayoutEffect that runs on first commit reads a non-zero value.
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 1200;
      },
    });
    try {
      const { container } = render(<Harness />);
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
      expect(scroller.scrollTop).toBe(1200);
    } finally {
      if (desc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', desc);
    }
  });

  it('renders the load-more sentinel above the messages so it sits at the top of the scroll area', () => {
    const { container } = renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
      />,
    );
    const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
    // Sentinel must be the FIRST child so it lives at the top of the
    // scroll content; the user reaches it by scrolling up to older
    // messages, which is where the fetch trigger belongs.
    expect(scroller.firstElementChild?.getAttribute('data-testid')).toBe('message-list-load-more');
  });

  it('snaps to the bottom when the user sends a new message (bottom of list changes to an own message)', async () => {
    let resizeCallback: (() => void) | null = null;
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; resizeCallback = cb; }
      observe() {}
      disconnect() { resizeCallback = null; }
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <MessageList {...defaultProps} {...props} />
          </BrowserRouter>
        </QueryClientProvider>
      );

      const { rerender, container } = render(
        wrap({
          pages: [
            {
              items: [
                makeMessage({ id: 'm-1', authorID: 'user-2', body: 'hi' }),
              ],
            },
          ],
        }),
      );
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
      Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });

      // User sends a new message. The bottom of the list is now their
      // own ID; the effect should snap scrollTop to scrollHeight.
      rerender(
        wrap({
          pages: [
            {
              items: [
                makeMessage({ id: 'm-2', authorID: 'user-1', body: 'mine' }),
                makeMessage({ id: 'm-1', authorID: 'user-2', body: 'hi' }),
              ],
            },
          ],
        }),
      );
      expect(scroller.scrollTop).toBe(1500);

      // Async content (an attachment loading in) makes the inner
      // container resize. The ResizeObserver re-stick callback should
      // re-pin to the new scrollHeight so the user's just-sent message
      // doesn't get pushed above the viewport.
      Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
      resizeCallback?.();
      expect(scroller.scrollTop).toBe(2000);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('follows new messages from others when the user is already at the bottom (live-conversation mode)', () => {
    // The persistent bottom-stick observer fires when the messages
    // container grows. Use a callback-capturing RO mock so we can
    // simulate that growth on rerender.
    let resizeCallback: (() => void) | null = null;
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      cb: () => void;
      constructor(cb: () => void) { this.cb = cb; resizeCallback = cb; }
      observe() {}
      disconnect() { resizeCallback = null; }
      unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <MessageList {...defaultProps} {...props} />
          </BrowserRouter>
        </QueryClientProvider>
      );
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get() {
          // The mocked value is updated by the test below. Default
          // here is just so the initial mount has *some* height.
          return 0;
        },
      });
      const { rerender, container } = render(
        wrap({
          pages: [{ items: [makeMessage({ id: 'm-1', authorID: 'user-2' })] }],
        }),
      );
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
      Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
      Object.defineProperty(scroller, 'clientHeight', { value: 700, configurable: true });
      // Re-pin via the persistent observer so wasAtBottomRef gets
      // updated by the resulting scroll event.
      resizeCallback?.();
      expect(scroller.scrollTop).toBe(1500);
      // distanceFromBottom = 1500 - 1500 - 700 < 120 → at bottom.

      // A teammate sends a message; messages container grows from
      // 1500 to 1600. The persistent RO fires and stick() runs
      // because wasAtBottomRef is still true.
      Object.defineProperty(scroller, 'scrollHeight', { value: 1600, configurable: true });
      rerender(
        wrap({
          pages: [
            {
              items: [
                makeMessage({ id: 'm-2', authorID: 'user-2', body: 'live!' }),
                makeMessage({ id: 'm-1', authorID: 'user-2', body: 'hi' }),
              ],
            },
          ],
        }),
      );
      resizeCallback?.();
      expect(scroller.scrollTop).toBe(1600);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('does NOT follow new messages from others when the user has scrolled up to read older content', () => {
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {} disconnect() {} unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <MessageList {...defaultProps} {...props} />
          </BrowserRouter>
        </QueryClientProvider>
      );
      const { rerender, container } = render(
        wrap({
          pages: [{ items: [makeMessage({ id: 'm-1', authorID: 'user-2' })] }],
        }),
      );
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
      Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
      Object.defineProperty(scroller, 'clientHeight', { value: 700, configurable: true });
      // User scrolled up to read older content (well outside the 120px
      // "at bottom" window): distanceFromBottom = 1500 - 200 - 700 = 600.
      scroller.scrollTop = 200;
      scroller.dispatchEvent(new Event('scroll'));

      // Someone else's message arrives. The reader stays put.
      Object.defineProperty(scroller, 'scrollHeight', { value: 1600, configurable: true });
      rerender(
        wrap({
          pages: [
            {
              items: [
                makeMessage({ id: 'm-2', authorID: 'user-2', body: 'theirs' }),
                makeMessage({ id: 'm-1', authorID: 'user-2', body: 'hi' }),
              ],
            },
          ],
        }),
      );
      expect(scroller.scrollTop).toBe(200);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('does NOT scroll-to-bottom when the bottom message is a thread reply (lives in ThreadPanel, not main list)', () => {
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {} disconnect() {} unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <MessageList {...defaultProps} {...props} />
          </BrowserRouter>
        </QueryClientProvider>
      );
      const { rerender, container } = render(
        wrap({
          pages: [{ items: [makeMessage({ id: 'm-1', authorID: 'user-1' })] }],
        }),
      );
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
      Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
      scroller.scrollTop = 200;

      // The user posts a thread reply. It's a new bottom of allMessages
      // but parentMessageID is set, so it doesn't render in the main
      // list and shouldn't affect the main scroll position.
      rerender(
        wrap({
          pages: [
            {
              items: [
                makeMessage({
                  id: 'm-reply',
                  authorID: 'user-1',
                  parentMessageID: 'm-1',
                  body: 'reply',
                }),
                makeMessage({ id: 'm-1', authorID: 'user-1', body: 'root' }),
              ],
            },
          ],
        }),
      );
      expect(scroller.scrollTop).toBe(200);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('does NOT scroll-to-bottom when an older-page prepend revives the user\'s own message in the list', async () => {
    // Regression: the previous "scroll-to-bottom on send" detection
    // watched the newest own message anywhere in allMessages. When an
    // older page prepended and contained any of the user's older
    // messages, the watcher saw null → ID and treated it as a fresh
    // send — slamming the user to the bottom of the channel after
    // every load. The detector now keys off the BOTTOM message of the
    // chat instead, which prepends never touch.
    const origRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {} disconnect() {} unobserve() {}
    } as unknown as typeof ResizeObserver;
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <MessageList {...defaultProps} {...props} />
          </BrowserRouter>
        </QueryClientProvider>
      );

      // Initial render: page 1 (newest batch). No own messages here —
      // newestOwn is null. The bottom message is m-newest by someone else.
      const { rerender, container } = render(
        wrap({
          pages: [
            {
              items: [
                makeMessage({ id: 'm-newest', authorID: 'user-2', body: 'hi' }),
              ],
            },
          ],
          hasNextPage: true,
        }),
      );
      const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
      // The user has scrolled up to read older content.
      Object.defineProperty(scroller, 'scrollHeight', { value: 1000, configurable: true });
      scroller.scrollTop = 200;

      // Older page commits. It contains an older OWN message — under
      // the old logic this would trip "newestOwn changed null → ID"
      // and snap the user to scrollHeight (1000). Under the fix,
      // bottom didn't change so nothing fires.
      rerender(
        wrap({
          pages: [
            {
              items: [
                makeMessage({ id: 'm-newest', authorID: 'user-2', body: 'hi' }),
              ],
            },
            {
              items: [
                makeMessage({ id: 'm-own-old', authorID: 'user-1', body: 'mine' }),
              ],
            },
          ],
          hasNextPage: true,
        }),
      );

      // scrollTop must NOT have been pinned to scrollHeight. It can be
      // adjusted by the anchor-restore logic, but never to 1000 (the
      // scrollHeight, which would mean "snapped to bottom").
      expect(scroller.scrollTop).not.toBe(1000);
    } finally {
      globalThis.ResizeObserver = origRO;
    }
  });

  it('does NOT disable browser scroll-anchoring — the browser preserves reading position when content above the viewport changes height (older-page prepends, thread reply counts updating, reactions added on messages above)', () => {
    // Regression: a previous attempt set `overflow-anchor: none` and
    // ran a manual anchor-restore on every fetchNextPage commit. That
    // covered older-page prepends but not OTHER above-viewport shifts
    // — when a thread reply landed, its root message's reply-count
    // bar grew, content below shifted up, and the user's view drifted
    // bit by bit. The browser's native scroll anchoring handles every
    // one of these cases uniformly; we leave it on by NOT setting
    // overflow-anchor: none on the scroll container.
    const { container } = renderWithProviders(
      <MessageList {...defaultProps} pages={[{ items: [makeMessage()] }]} />,
    );
    const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
    expect(scroller.style.overflowAnchor).toBe('');
  });

  it('auto-fetches the next page when the load-more sentinel scrolls into view', () => {
    const io = installFakeIntersectionObserver();
    try {
      const fetchNextPage = vi.fn();
      renderWithProviders(
        <MessageList
          {...defaultProps}
          fetchNextPage={fetchNextPage}
          pages={[{ items: [makeMessage()] }]}
          hasNextPage={true}
        />,
      );
      io.fire();
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
    } finally {
      io.restore();
    }
  });

  it('uses userMap to display author names', () => {
    const pages = [
      {
        items: [
          makeMessage({ id: 'msg-1', authorID: 'user-2', body: 'Hi from Bob' }),
        ],
      },
    ];

    renderWithProviders(
      <MessageList {...defaultProps} pages={pages} />,
    );

    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders system messages inline without avatar/edit controls', () => {
    const pages = [
      {
        items: [
          makeMessage({
            id: 'sys-1',
            authorID: 'system',
            body: 'Alice joined the channel',
            system: true,
          }),
        ],
      },
    ];

    renderWithProviders(<MessageList {...defaultProps} pages={pages} />);

    // Body text appears
    expect(screen.getByText('Alice joined the channel')).toBeInTheDocument();
    // No edit/delete buttons since it's a system message
    expect(screen.queryByLabelText('Edit message')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Delete message')).not.toBeInTheDocument();
  });
});
