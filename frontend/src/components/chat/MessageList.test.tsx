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
  // Match the real IntersectionObserver constructor signature
  // (callback, options?) so production callers passing options
  // aren't flagged as supplying superfluous arguments.
  class FakeObserver {
    private cb: IntersectionObserverCallback;
    root: Element | Document | null = null;
    rootMargin = '';
    thresholds: number[] = [];
    constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.cb = cb;
      if (options?.root instanceof Element || options?.root instanceof Document) {
        this.root = options.root;
      }
      if (options?.rootMargin !== undefined) this.rootMargin = options.rootMargin;
      const thresholds = options?.threshold;
      this.thresholds = Array.isArray(thresholds)
        ? thresholds
        : thresholds !== undefined
          ? [thresholds]
          : [];
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

  describe('deep-link anchor (anchorMsgId)', () => {
    // Replace scrollIntoView with a spy. jsdom doesn't implement layout
    // so we just observe whether the anchor element's scrollIntoView was
    // called and with what options.
    function withScrollIntoViewSpy<T>(fn: (spy: ReturnType<typeof vi.fn>) => T): T {
      const original = Element.prototype.scrollIntoView;
      const spy = vi.fn();
      Element.prototype.scrollIntoView = spy as unknown as typeof Element.prototype.scrollIntoView;
      try {
        return fn(spy);
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    }

    it('does NOT snap to the bottom when anchorMsgId is set (deep-link mode)', () => {
      withScrollIntoViewSpy(() => {
        const { container } = renderWithProviders(
          <MessageList
            {...defaultProps}
            pages={[
              {
                items: [
                  makeMessage({ id: 'm-2', body: 'newer', createdAt: '2026-04-24T10:31:00Z' }),
                  makeMessage({ id: 'm-1', body: 'older', createdAt: '2026-04-24T10:30:00Z' }),
                ],
              },
            ]}
            anchorMsgId="m-1"
          />,
        );
        const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
        Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
        // The bottom-stick layout effect is gated on anchorMsgId; we
        // never write scrollTop = scrollHeight in deep-link mode.
        expect(scroller.scrollTop).toBe(0);
      });
    });

    it('scrolls the anchor message into view (centered) when anchorMsgId is set', () => {
      withScrollIntoViewSpy((spy) => {
        renderWithProviders(
          <MessageList
            {...defaultProps}
            pages={[
              {
                items: [
                  makeMessage({ id: 'm-2', body: 'newer', createdAt: '2026-04-24T10:31:00Z' }),
                  makeMessage({ id: 'm-1', body: 'older', createdAt: '2026-04-24T10:30:00Z' }),
                ],
              },
            ]}
            anchorMsgId="m-1"
          />,
        );
        // Spy receives the call with block:'center'. The element it was
        // called on is the message div with id="msg-m-1".
        expect(spy).toHaveBeenCalled();
        const opts = spy.mock.calls[0]?.[0] as ScrollIntoViewOptions | undefined;
        expect(opts?.block).toBe('center');
        expect(spy.mock.instances[0]).toBe(document.getElementById('msg-m-1'));
      });
    });

    it('applies the highlight ring on the anchor and removes it after the timeout', () => {
      vi.useFakeTimers();
      try {
        withScrollIntoViewSpy(() => {
          renderWithProviders(
            <MessageList
              {...defaultProps}
              pages={[{ items: [makeMessage({ id: 'm-1', body: 'target' })] }]}
              anchorMsgId="m-1"
            />,
          );
          const target = document.getElementById('msg-m-1');
          expect(target?.classList.contains('ring-1')).toBe(true);
          expect(target?.classList.contains('ring-amber-400/50')).toBe(true);
          vi.advanceTimersByTime(2300);
          expect(target?.classList.contains('ring-1')).toBe(false);
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT re-scroll to the anchor on a subsequent page commit (no jump-back when paginating)', () => {
      withScrollIntoViewSpy((spy) => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
          <QueryClientProvider client={qc}>
            <BrowserRouter>
              <MessageList {...defaultProps} {...props} />
            </BrowserRouter>
          </QueryClientProvider>
        );
        const initialPages = [
          {
            items: [
              makeMessage({ id: 'm-2', body: 'newer', createdAt: '2026-04-24T10:31:00Z' }),
              makeMessage({ id: 'm-1', body: 'older', createdAt: '2026-04-24T10:30:00Z' }),
            ],
          },
        ];
        const { rerender } = render(wrap({ pages: initialPages, anchorMsgId: 'm-1' }));
        expect(spy).toHaveBeenCalledTimes(1);

        // A newer page is fetched (load-newer sentinel triggered). The
        // pages array grows; the deep-link scroll must NOT fire again,
        // otherwise the user gets yanked back to the anchor every time
        // they try to read newer content.
        rerender(
          wrap({
            pages: [
              ...initialPages,
              {
                items: [
                  makeMessage({ id: 'm-3', body: 'even newer', createdAt: '2026-04-24T10:32:00Z' }),
                ],
              },
            ],
            anchorMsgId: 'm-1',
          }),
        );
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });

    it('persistent bottom-stick observer does NOT yank to bottom in deep-link mode (wasAtBottomRef stays false)', () => {
      withScrollIntoViewSpy(() => {
        let resizeCallback: (() => void) | null = null;
        const origRO = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
          cb: () => void;
          constructor(cb: () => void) { this.cb = cb; resizeCallback = cb; }
          observe() {}
          disconnect() { resizeCallback = null; }
          unobserve() {}
        } as unknown as typeof ResizeObserver;
        // useAtBottomRef computes "at bottom" off scrollHeight/clientHeight
        // on mount. In a real browser scrollIntoView moves scrollTop and
        // scrollHeight is real, so the centered-anchor case works out to
        // "not at bottom". jsdom has no layout, so we patch the prototype
        // before render to mirror those numbers.
        const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
        const clientDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
          configurable: true,
          get() { return 1500; },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
          configurable: true,
          get() { return 600; },
        });
        try {
          const { container } = renderWithProviders(
            <MessageList
              {...defaultProps}
              pages={[{ items: [makeMessage({ id: 'm-1', body: 'target' })] }]}
              anchorMsgId="m-1"
            />,
          );
          const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
          // Mid-window position simulating where the deep-link landed.
          scroller.scrollTop = 400;
          scroller.dispatchEvent(new Event('scroll'));
          // Async content settles → ResizeObserver fires. The bottom-
          // stick must NOT trip because the user is mid-history.
          resizeCallback?.();
          expect(scroller.scrollTop).toBe(400);
        } finally {
          if (heightDesc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', heightDesc);
          else delete (HTMLElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
          if (clientDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientDesc);
          else delete (HTMLElement.prototype as unknown as { clientHeight?: unknown }).clientHeight;
          globalThis.ResizeObserver = origRO;
        }
      });
    });

    it('re-clicking the same search hit (anchor unchanged, navigation token changes) re-fires the scroll', () => {
      // anchorRevision threads useLocation().key through. A re-click
      // pushes a new history entry → fresh key → re-trigger, even
      // though anchorMsgId is identical.
      withScrollIntoViewSpy((spy) => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
          <QueryClientProvider client={qc}>
            <BrowserRouter>
              <MessageList {...defaultProps} {...props} />
            </BrowserRouter>
          </QueryClientProvider>
        );
        const { rerender } = render(
          wrap({
            pages: [{ items: [makeMessage({ id: 'm-1', body: 'target' })] }],
            anchorMsgId: 'm-1',
            anchorRevision: 'nav-1',
          }),
        );
        expect(spy).toHaveBeenCalledTimes(1);

        // Same anchor, same navigation key — must NOT re-fire (page
        // fetches re-render with identical props).
        rerender(
          wrap({
            pages: [{ items: [makeMessage({ id: 'm-1', body: 'target' }), makeMessage({ id: 'm-2' })] }],
            anchorMsgId: 'm-1',
            anchorRevision: 'nav-1',
          }),
        );
        expect(spy).toHaveBeenCalledTimes(1);

        // Re-click the same hit → new navigation key → re-fire.
        rerender(
          wrap({
            pages: [{ items: [makeMessage({ id: 'm-1', body: 'target' }), makeMessage({ id: 'm-2' })] }],
            anchorMsgId: 'm-1',
            anchorRevision: 'nav-2',
          }),
        );
        expect(spy).toHaveBeenCalledTimes(2);
      });
    });

    it('the follow-anchor RO observes the inner messages container, not a load-newer sentinel (regression: cross-parent search-result scroll drifted)', () => {
      // Both load-more (top) and load-newer (bottom) sentinels render
      // when the around-window has older AND newer pages remaining —
      // the typical deep-link case from /search. Earlier the RO was
      // wired to scroller.lastElementChild, which in this layout is
      // the fixed-height load-newer sentinel that never resizes when
      // real message content above settles. Result: the anchor drifted
      // off-screen as avatars/attachments loaded. The fix observes the
      // dedicated inner container instead.
      withScrollIntoViewSpy(() => {
        const observed: Element[] = [];
        const origRO = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
          constructor(_cb: () => void) {}
          observe(el: Element) { observed.push(el); }
          disconnect() {}
          unobserve() {}
        } as unknown as typeof ResizeObserver;
        try {
          const { container } = renderWithProviders(
            <MessageList
              {...defaultProps}
              pages={[{ items: [makeMessage({ id: 'm-1', body: 'target' })] }]}
              hasNextPage
              hasPreviousPage
              fetchPreviousPage={vi.fn()}
              isFetchingPreviousPage={false}
              anchorMsgId="m-1"
            />,
          );
          // Both sentinels are present.
          expect(container.querySelector('[data-testid="message-list-load-more"]')).toBeInTheDocument();
          expect(container.querySelector('[data-testid="message-list-load-newer"]')).toBeInTheDocument();
          // Among the elements observed by the various ResizeObservers,
          // none should be a sentinel — they must be the real
          // messages container (.p-4.space-y-1).
          for (const el of observed) {
            expect(el.getAttribute('data-testid')).not.toBe('message-list-load-more');
            expect(el.getAttribute('data-testid')).not.toBe('message-list-load-newer');
          }
        } finally {
          globalThis.ResizeObserver = origRO;
        }
      });
    });

    it('re-centers the anchor when content above it grows (avatars/attachments loading after the initial scroll)', () => {
      // The original "scroll once" approach drifted off-screen as
      // avatars/attachments/unfurls above the anchor finished loading
      // — exactly the scenario where deep-links from /search felt
      // broken. The follow-anchor ResizeObserver re-centers until the
      // user takes over.
      withScrollIntoViewSpy((spy) => {
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
          renderWithProviders(
            <MessageList
              {...defaultProps}
              pages={[{ items: [makeMessage({ id: 'm-1', body: 'target' })] }]}
              anchorMsgId="m-1"
            />,
          );
          // Initial mount → 1 scrollIntoView for the anchor.
          expect(spy).toHaveBeenCalledTimes(1);
          // Async content above the anchor finishes loading; the
          // inner content resizes. The follow-anchor RO re-centers.
          resizeCallback?.();
          expect(spy).toHaveBeenCalledTimes(2);
          // And again — it keeps re-centering as long as the user
          // hasn't scrolled.
          resizeCallback?.();
          expect(spy).toHaveBeenCalledTimes(3);
        } finally {
          globalThis.ResizeObserver = origRO;
        }
      });
    });

    it('reinstalls the follow-anchor RO after a StrictMode-style cleanup + re-fire (regression: dev-mode double-effect was tearing down follow-anchor permanently)', () => {
      // React StrictMode runs effects twice in dev: setup, cleanup,
      // setup. Earlier the dedup ref short-circuited the second setup
      // — so production looked fine but dev mode silently lost the
      // follow-anchor RO. Async content settling above the anchor
      // then drifted the message off-screen.
      withScrollIntoViewSpy((spy) => {
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
          const Tree = (
            <QueryClientProvider client={qc}>
              <BrowserRouter>
                <MessageList
                  {...defaultProps}
                  pages={[{ items: [makeMessage({ id: 'm-1', body: 'target' })] }]}
                  anchorMsgId="m-1"
                />
              </BrowserRouter>
            </QueryClientProvider>
          );
          // Simulate StrictMode: render → unmount → render. Each cycle
          // fires layout effect setup + cleanup. After the second
          // setup the RO must still be live.
          const { unmount } = render(Tree);
          unmount();
          render(Tree);
          // Initial scrolls fired during both mounts.
          expect(spy).toHaveBeenCalled();
          const beforeResize = spy.mock.calls.length;
          // Async content settles after the second mount — RO must
          // fire and re-center, proving the follow-anchor was
          // reinstalled on the second setup.
          resizeCallback?.();
          expect(spy.mock.calls.length).toBeGreaterThan(beforeResize);
        } finally {
          globalThis.ResizeObserver = origRO;
        }
      });
    });

    it('stops following the anchor as soon as the user scrolls', () => {
      withScrollIntoViewSpy((spy) => {
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
          const { container } = renderWithProviders(
            <MessageList
              {...defaultProps}
              pages={[{ items: [makeMessage({ id: 'm-1', body: 'target' })] }]}
              anchorMsgId="m-1"
            />,
          );
          const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
          expect(spy).toHaveBeenCalledTimes(1);
          // User scrolls — scrollTop diverges from our last expected
          // value by more than the 5px threshold.
          scroller.scrollTop = 600;
          scroller.dispatchEvent(new Event('scroll'));
          // Subsequent content settles — but we've stopped following,
          // so no further scrollIntoView.
          resizeCallback?.();
          expect(spy).toHaveBeenCalledTimes(1);
        } finally {
          globalThis.ResizeObserver = origRO;
        }
      });
    });

    it('stops following the anchor after the 1.5s safety window', () => {
      vi.useFakeTimers();
      try {
        withScrollIntoViewSpy((spy) => {
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
            renderWithProviders(
              <MessageList
                {...defaultProps}
                pages={[{ items: [makeMessage({ id: 'm-1', body: 'target' })] }]}
                anchorMsgId="m-1"
              />,
            );
            expect(spy).toHaveBeenCalledTimes(1);
            // Far beyond the 1.5s window. Any further content shifts
            // are the user's problem now.
            vi.advanceTimersByTime(1600);
            resizeCallback?.();
            expect(spy).toHaveBeenCalledTimes(1);
          } finally {
            globalThis.ResizeObserver = origRO;
          }
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT auto-stick to the live tail in deep-link mode even when a new message arrives at the bottom (regression: DM deep-link from /search yanked reader away from anchor)', () => {
      // In deep-link mode the reader explicitly went to a specific
      // message — they never opted into live-tail follow. Auto-
      // sticking on every new message arrival would yank them away
      // from the anchor whenever fetchPreviousPage adds a newer
      // page or a WebSocket invalidation refetches.
      let bottomStickCB: (() => void) | null = null;
      const origRO = globalThis.ResizeObserver;
      globalThis.ResizeObserver = class {
        cb: () => void;
        constructor(cb: () => void) {
          this.cb = cb;
          if (bottomStickCB === null) bottomStickCB = cb;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      } as unknown as typeof ResizeObserver;
      try {
        withScrollIntoViewSpy(() => {
          const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
          const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
            <QueryClientProvider client={qc}>
              <BrowserRouter>
                <MessageList {...defaultProps} {...props} />
              </BrowserRouter>
            </QueryClientProvider>
          );
          const initialPages = [{ items: [
            makeMessage({ id: 'm-target', authorID: 'user-2', body: 'target' }),
            makeMessage({ id: 'm-old', authorID: 'user-2', body: 'old' }),
          ] }];
          const { rerender, container } = render(
            wrap({ pages: initialPages, anchorMsgId: 'm-target' }),
          );
          const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
          Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });

          // Reader was scrolled near the bottom of the loaded set.
          Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
          scroller.scrollTop = 700;
          scroller.dispatchEvent(new Event('scroll'));

          // fetchPreviousPage adds a newer page. innerRef grows.
          // wasAtBottomRef may be true (clamp / reader near bottom).
          // In deep-link mode, the bottom-stick RO must NOT engage —
          // the reader never asked to follow the live tail.
          rerender(
            wrap({
              pages: [{ items: [
                makeMessage({ id: 'm-new', authorID: 'user-2', body: 'incoming' }),
                makeMessage({ id: 'm-target', authorID: 'user-2', body: 'target' }),
                makeMessage({ id: 'm-old', authorID: 'user-2', body: 'old' }),
              ] }],
              anchorMsgId: 'm-target',
            }),
          );
          Object.defineProperty(scroller, 'scrollHeight', { value: 1700, configurable: true });
          bottomStickCB?.();
          // scrollTop unchanged — the reader stays where they were.
          expect(scroller.scrollTop).toBe(700);
        });
      } finally {
        globalThis.ResizeObserver = origRO;
      }
    });

    it('preserves the reader\'s visible message when the scroller width changes (regression: closing the thread panel reflowed and dragged to the latest message)', () => {
      // The browser's overflow-anchor: auto doesn't reliably handle
      // scroller width changes — when the right panel closes, the
      // main column widens, content re-wraps with shorter messages,
      // scrollHeight drops, and if the reader was past the new max
      // scrollTop the browser clamps them down. Manual anchoring:
      // remember the top-visible message before the reflow, then
      // adjust scrollTop so its post-reflow viewport offset matches.
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
        const Tree = (
          <QueryClientProvider client={qc}>
            <BrowserRouter>
              <MessageList
                {...defaultProps}
                pages={[{ items: [
                  makeMessage({ id: 'm-3', authorID: 'user-2', body: 'three' }),
                  makeMessage({ id: 'm-2', authorID: 'user-2', body: 'two' }),
                  makeMessage({ id: 'm-1', authorID: 'user-2', body: 'one' }),
                ] }]}
              />
            </BrowserRouter>
          </QueryClientProvider>
        );
        const { container } = render(Tree);
        const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
        Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });
        Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true });
        Object.defineProperty(scroller, 'clientWidth', { value: 600, configurable: true });

        // Reader scrolls to msg-2. Mock its position to be at the
        // top of viewport offset by 0px in the pre-reflow layout.
        const target = document.getElementById('msg-m-2') as HTMLElement;
        const scrollerRectBefore = { top: 100, bottom: 900 };
        scroller.getBoundingClientRect = () =>
          ({ ...scrollerRectBefore } as DOMRect);
        target.getBoundingClientRect = () =>
          ({ top: 100, bottom: 200 } as DOMRect);
        scroller.scrollTop = 1200;
        scroller.dispatchEvent(new Event('scroll'));
        // visibleAnchorRef now records msg-m-2 at offset=0.

        // Side panel closes — scroller widens (600 → 1000), content
        // re-wraps with less wrapping, target message is now at a
        // SHORTER offset from the inner top because content above
        // shrank. Without preservation, scrollTop stays 1200 but
        // target moved up to a NEGATIVE offset — invisible.
        Object.defineProperty(scroller, 'clientWidth', { value: 1000, configurable: true });
        Object.defineProperty(scroller, 'scrollHeight', { value: 1800, configurable: true });
        target.getBoundingClientRect = () =>
          ({ top: -200, bottom: -100 } as DOMRect);
        resizeCallback?.();
        // Adjustment: delta = -300 (currentOffset) - 0 (anchor.offset) = -300.
        // scrollTop should decrease by 300.
        expect(scroller.scrollTop).toBe(900);
      } finally {
        globalThis.ResizeObserver = origRO;
      }
    });

    it('persistent bottom-stick RO does NOT yank to bottom on content shrinkage (regression: closing the thread panel jumped the main list to the latest message)', () => {
      // Closing a side panel widens the main column → content
      // re-wraps with less line-wrapping → scrollHeight drops → the
      // browser clamps scrollTop within reach of the bottom →
      // useAtBottomRef flips wasAtBottomRef=true on the resulting
      // scroll event. The bottom-stick RO would then stick to the
      // new (smaller) bottom, yanking the reader from the older
      // message they had been reading.
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
        const Tree = (
          <QueryClientProvider client={qc}>
            <BrowserRouter>
              <MessageList
                {...defaultProps}
                pages={[{ items: [makeMessage({ id: 'm-1', authorID: 'user-2' })] }]}
              />
            </BrowserRouter>
          </QueryClientProvider>
        );
        const { container } = render(Tree);
        const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
        Object.defineProperty(scroller, 'clientHeight', { value: 800, configurable: true });

        // Reader is at the live tail. Initial mount: scrollHeight is
        // 2500. The bottom-stick layout effect ran, marked
        // wasAtBottomRef=true on stick(). RO now installed.
        Object.defineProperty(scroller, 'scrollHeight', { value: 2500, configurable: true });
        // Prime the RO's lastScrollHeight by firing once at the
        // current size — first fire is a no-op for the growth check.
        resizeCallback?.();

        // Reader scrolls up to read an older message. atBottomRef
        // flips false via the scroll listener. (Skip dispatching a
        // real scroll event; just set scrollTop and assert that the
        // RO doesn't move it on the subsequent shrinkage.)
        scroller.scrollTop = 800;

        // Side panel closes — main column widens, content re-wraps
        // with less wrapping, scrollHeight DROPS to 2000.
        Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
        resizeCallback?.();

        // Reader's scroll position must be untouched. Without the
        // growth-only guard, the RO would have stuck to scrollHeight
        // (2000) — yanking them to the latest of the (newly-shorter)
        // main list.
        expect(scroller.scrollTop).toBe(800);
      } finally {
        globalThis.ResizeObserver = origRO;
      }
    });

    it('persistent bottom-stick RO stays a no-op while in deep-link mode, even if the anchor lands within the at-bottom threshold (regression: thread action bar click yanked to live tail)', () => {
      // Recent threads (the typical /threads-page deep link) land
      // near the bottom of the loaded around-window. After
      // scrollIntoView, useAtBottomRef.update() flips
      // wasAtBottomRef=true on its mount-time read AND on the
      // post-scroll event. A later RO fire (from any settling
      // content) would then yank the reader to the live tail. The
      // gate keeps the bottom-stick RO a no-op until the reader has
      // actually moved the scroll themselves.
      //
      // useAtBottomRef defaults its ref to TRUE and its mount-time
      // update() reads the prototype-defined scrollHeight=1000 etc.
      // below, which computes to "at bottom" (negative distance).
      // That gives the bottom-stick RO the worst-case input;
      // verifying scrollTop doesn't move proves the gate is in place.
      withScrollIntoViewSpy(() => {
        let bottomStickRO: (() => void) | null = null;
        const origRO = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
          cb: () => void;
          constructor(cb: () => void) {
            this.cb = cb;
            // The bottom-stick RO is the FIRST one set up
            // (declaration order; runs before the anchor effect).
            if (!bottomStickRO) bottomStickRO = cb;
          }
          observe() {}
          disconnect() {}
          unobserve() {}
        } as unknown as typeof ResizeObserver;
        const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
        const clientDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
        Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
          configurable: true,
          get() { return 1000; },
        });
        Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
          configurable: true,
          get() { return 1200; },
        });
        try {
          const { container } = renderWithProviders(
            <MessageList
              {...defaultProps}
              pages={[{ items: [makeMessage({ id: 'm-1', body: 'target' })] }]}
              anchorMsgId="m-1"
            />,
          );
          const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
          // wasAtBottomRef is now true (1000 - 0 - 1200 = -200 < 120
          // → "at bottom"). Simulate content settling — bottom-stick
          // RO must NOT yank because anchor is set and the user
          // hasn't scrolled.
          bottomStickRO?.();
          expect(scroller.scrollTop).toBe(0);
        } finally {
          if (heightDesc) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', heightDesc);
          else delete (HTMLElement.prototype as unknown as { scrollHeight?: unknown }).scrollHeight;
          if (clientDesc) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientDesc);
          else delete (HTMLElement.prototype as unknown as { clientHeight?: unknown }).clientHeight;
          globalThis.ResizeObserver = origRO;
        }
      });
    });

    it('does NOT auto-scroll to bottom when load-newer fetches a page whose bottom is the user\'s own (regression: jumps to latest while paging through newer messages)', () => {
      // In deep-link mode, scrolling down triggers fetchPreviousPage
      // which APPENDS a newer page. The previous bottom message
      // ends up several positions up — distinguishing this from a
      // single-message append (a fresh send). Without that check,
      // the lastBottom effect treats the new page's last own
      // message as a fresh send and yanks to the bottom.
      withScrollIntoViewSpy(() => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
          <QueryClientProvider client={qc}>
            <BrowserRouter>
              <MessageList {...defaultProps} {...props} />
            </BrowserRouter>
          </QueryClientProvider>
        );

        // Initial: deep-link landing on msg-target. Around-window
        // has older messages below the target, none yet from a
        // newer page.
        const aroundPage = {
          items: [
            makeMessage({ id: 'around-bottom', authorID: 'user-2', body: 'around bottom' }),
            makeMessage({ id: 'msg-target', authorID: 'user-2', body: 'target' }),
            makeMessage({ id: 'around-old', authorID: 'user-2', body: 'older' }),
          ],
        };
        const { rerender, container } = render(
          wrap({ pages: [aroundPage], anchorMsgId: 'msg-target', hasPreviousPage: true, fetchPreviousPage: vi.fn() }),
        );
        const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
        Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
        // After deep-link, simulate the user scrolling down — they're
        // mid-list now, definitely not at scrollHeight.
        scroller.scrollTop = 600;

        // Newer page arrives via fetchPreviousPage. Its last message
        // is the user's own. Under the old code this looked like a
        // fresh send and scrollTop got set to scrollHeight.
        rerender(
          wrap({
            pages: [
              aroundPage,
              {
                items: [
                  makeMessage({ id: 'newer-bottom-own', authorID: 'user-1', body: 'mine, latest' }),
                  makeMessage({ id: 'newer-mid', authorID: 'user-2', body: 'mid' }),
                  makeMessage({ id: 'newer-top', authorID: 'user-2', body: 'top' }),
                ],
              },
            ],
            anchorMsgId: 'msg-target',
            hasPreviousPage: false,
            fetchPreviousPage: vi.fn(),
          }),
        );
        Object.defineProperty(scroller, 'scrollHeight', { value: 2400, configurable: true });
        // Bottom shifted from around-bottom to newer-bottom-own —
        // multiple positions, not a single append. lastBottom must
        // not fire.
        expect(scroller.scrollTop).toBe(600);
      });
    });

    it('does NOT auto-scroll to bottom on cross-parent navigation when the around-window\'s bottom message is the user\'s own (regression: "scrolls and scrolls back to the latest message")', () => {
      // Cross-parent navigation transitions allMessages through an
      // empty state: [old A's tail] → [] → [B's around-window]. The
      // lastBottom effect was reading the final transition as a
      // "fresh send" if the around-window's last message happened to
      // be the user's own (very common in DMs / quiet channels).
      // That set wasAtBottomRef=true, after which the persistent
      // bottom-stick RO kept yanking on every settling avatar — the
      // exact "scrolls and scrolls" symptom.
      withScrollIntoViewSpy(() => {
        let bottomStickRO: (() => void) | null = null;
        const origRO = globalThis.ResizeObserver;
        globalThis.ResizeObserver = class {
          cb: () => void;
          constructor(cb: () => void) {
            this.cb = cb;
            // First RO installed is the bottom-stick (declared
            // before the anchor effect). Capture it to simulate
            // content settling later.
            if (!bottomStickRO) bottomStickRO = cb;
          }
          observe() {}
          disconnect() {}
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

          // Render 1: old channel A's live tail. Bottom is someone's
          // own message — wasAtBottomRef gets set, ref tracks bottom.
          const { rerender, container } = render(
            wrap({
              pages: [{ items: [makeMessage({ id: 'a-bottom', authorID: 'user-1', body: 'A bottom (own)' })] }],
              channelId: 'A-id',
            }),
          );
          const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
          Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
          Object.defineProperty(scroller, 'clientHeight', { value: 700, configurable: true });

          // Render 2: empty state during query refetch (channel B
          // around-window query in flight).
          rerender(
            wrap({
              pages: [{ items: [] }],
              channelId: 'B-id',
              anchorMsgId: 'msg-target',
            }),
          );

          // Render 3: B's around-window arrives. Bottom of the
          // around-window is the user's own message (typical pattern).
          rerender(
            wrap({
              pages: [{
                items: [
                  makeMessage({ id: 'b-bottom-own', authorID: 'user-1', body: 'B around bottom (own)' }),
                  makeMessage({ id: 'msg-target', authorID: 'user-2', body: 'target' }),
                  makeMessage({ id: 'b-old', authorID: 'user-2', body: 'older' }),
                ],
              }],
              channelId: 'B-id',
              anchorMsgId: 'msg-target',
            }),
          );

          // The buggy cascade was: lastBottom fires (own at bottom)
          // → scrollTop=scrollHeight + wasAtBottomRef=true → RO
          // re-yanks on resize. Reset scrollTop here to isolate the
          // assertion: a follow-up resize must NOT pull us to the
          // bottom (1500). The user is still mid-deep-link.
          scroller.scrollTop = 400;
          Object.defineProperty(scroller, 'scrollHeight', { value: 1700, configurable: true });
          bottomStickRO?.();
          expect(scroller.scrollTop).toBe(400);
        } finally {
          globalThis.ResizeObserver = origRO;
        }
      });
    });

    it('re-arms the bottom-stick when anchorMsgId clears (deep-link → live tail in same parent)', () => {
      withScrollIntoViewSpy(() => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrap = (props: Partial<React.ComponentProps<typeof MessageList>>) => (
          <QueryClientProvider client={qc}>
            <BrowserRouter>
              <MessageList {...defaultProps} {...props} />
            </BrowserRouter>
          </QueryClientProvider>
        );
        const pages = [
          {
            items: [
              makeMessage({ id: 'm-2', body: 'newer', createdAt: '2026-04-24T10:31:00Z' }),
              makeMessage({ id: 'm-1', body: 'older', createdAt: '2026-04-24T10:30:00Z' }),
            ],
          },
        ];
        const { rerender, container } = render(wrap({ pages, anchorMsgId: 'm-1' }));
        const scroller = container.querySelector('div.overflow-y-auto') as HTMLDivElement;
        Object.defineProperty(scroller, 'scrollHeight', { value: 1500, configurable: true });
        // Deep-link mode: not pinned to bottom.
        expect(scroller.scrollTop).toBe(0);

        // User clicks the channel/conversation in the sidebar — same
        // parent, anchor cleared. The bottom-stick should re-arm and
        // pin to the live tail on the next render.
        rerender(wrap({ pages, anchorMsgId: undefined }));
        expect(scroller.scrollTop).toBe(1500);
      });
    });
  });
});
