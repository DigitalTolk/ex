import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { createElement, forwardRef, useImperativeHandle, type ComponentType, type Ref } from 'react';
import { MessageList } from './MessageList';
import { shouldAutoStickMessageList } from './message-list-autostick';
import type { Message } from '@/types';
// ResizeObserver + offsetHeight/offsetWidth/clientHeight/clientWidth
// stubs are installed globally by frontend/src/test/setup.ts.

// Virtuoso mock: capture props + scrollToIndex calls for the regression
// contract tests, while still rendering Header/Footer and rows. The
// captured object is module-scoped and reset per test in beforeEach.
type Captured = {
  initialTopMostItemIndex?: unknown;
  followOutput?: unknown;
  atBottomThreshold?: number;
  alignToBottom?: boolean;
  computeItemKey?: (index: number, row: { key: string }) => string;
  defaultItemHeight?: number;
  increaseViewportBy?: unknown;
  data?: unknown[];
  startReached?: () => void;
  endReached?: () => void;
  itemContent?: (index: number, row?: unknown) => React.ReactNode;
  scrollToIndexCalls: Array<{ index: number | string; align?: string }>;
};
const captured: Captured = { scrollToIndexCalls: [] };

vi.mock('react-virtuoso', () => {
  type VirtuosoMockProps = {
    initialTopMostItemIndex?: unknown;
    followOutput?: unknown;
    atBottomThreshold?: number;
    alignToBottom?: boolean;
    computeItemKey?: (index: number, row: { key: string }) => string;
    defaultItemHeight?: number;
    increaseViewportBy?: unknown;
    data?: unknown[];
    startReached?: () => void;
    endReached?: () => void;
    itemContent?: (index: number, row?: unknown) => React.ReactNode;
    components?: { Header?: ComponentType; Footer?: ComponentType };
  };
  const Virtuoso = forwardRef((props: VirtuosoMockProps, ref: Ref<unknown>) => {
    captured.initialTopMostItemIndex = props.initialTopMostItemIndex;
    captured.followOutput = props.followOutput;
    captured.atBottomThreshold = props.atBottomThreshold;
    captured.alignToBottom = props.alignToBottom;
    captured.computeItemKey = props.computeItemKey;
    captured.defaultItemHeight = props.defaultItemHeight;
    captured.increaseViewportBy = props.increaseViewportBy;
    captured.data = props.data;
    captured.startReached = props.startReached;
    captured.endReached = props.endReached;
    captured.itemContent = props.itemContent;
    useImperativeHandle(ref, () => ({
      scrollToIndex: (arg: { index: number | string; align?: string }) => {
        captured.scrollToIndexCalls.push(arg);
      },
    }));
    const Header = props.components?.Header;
    const Footer = props.components?.Footer;
    return createElement(
      'div',
      { 'data-virtuoso-scroller': true },
      Header ? createElement(Header) : null,
      createElement('div', { 'data-viewport-type': 'window' }),
      ...(props.data ?? []).map((row, index) =>
        createElement('div', { key: index, 'data-testid': 'virtuoso-row' }, props.itemContent?.(index, row)),
      ),
      Footer ? createElement(Footer) : null,
    );
  });
  return { Virtuoso };
});

beforeEach(() => {
  captured.initialTopMostItemIndex = undefined;
  captured.followOutput = undefined;
  captured.atBottomThreshold = undefined;
  captured.alignToBottom = undefined;
  captured.computeItemKey = undefined;
  captured.defaultItemHeight = undefined;
  captured.increaseViewportBy = undefined;
  captured.data = undefined;
  captured.startReached = undefined;
  captured.endReached = undefined;
  captured.itemContent = undefined;
  captured.scrollToIndexCalls.length = 0;
});

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
  },
  pages: [],
};

describe('MessageList', () => {
  it('shows the empty state when there are no messages', () => {
    renderWithProviders(<MessageList {...defaultProps} pages={[{ items: [] }]} />);
    expect(screen.getByTestId('empty-message-list')).toBeInTheDocument();
  });

  it('renders the loading skeleton when isLoading is true', () => {
    const { container } = renderWithProviders(
      <MessageList {...defaultProps} isLoading={true} />,
    );
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('renders the intro at the top once we\'ve paged back to the start (hasNextPage=false)', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={false}
        intro={<div data-testid="my-intro">Welcome</div>}
      />,
    );
    expect(screen.getByTestId('my-intro')).toBeInTheDocument();
  });

  it('does NOT render the intro while older pages are still available (hasNextPage=true)', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
        intro={<div data-testid="my-intro">Welcome</div>}
      />,
    );
    expect(screen.queryByTestId('my-intro')).not.toBeInTheDocument();
  });

  it('shows the load-more sentinel + Loading earlier… text when fetching older pages', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
        isFetchingNextPage={true}
      />,
    );
    expect(screen.getByTestId('message-list-load-more')).toBeInTheDocument();
    expect(screen.getByText('Loading earlier messages…')).toBeInTheDocument();
  });

  it('shows the load-newer sentinel + Loading newer… text when fetching newer pages (deep-link mode)', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasPreviousPage={true}
        isFetchingPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-1"
      />,
    );
    expect(screen.getByTestId('message-list-load-newer')).toBeInTheDocument();
    expect(screen.getByText('Loading newer messages…')).toBeInTheDocument();
  });

  it('does not render load sentinels when there are no more pages in either direction', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={false}
        hasPreviousPage={false}
      />,
    );
    expect(screen.queryByTestId('message-list-load-more')).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-list-load-newer')).not.toBeInTheDocument();
  });

  it('renders the empty-state intro with the same horizontal padding as messages', () => {
    // Regression: the empty-state intro lived inside `<div p-4>`
    // while the with-messages intro rendered flush-left in
    // Virtuoso's Header. After posting the first message the intro
    // visibly shifted because px-4 disappeared. Both branches now
    // wrap the intro in `px-4`.
    const { container } = renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [] }]}
        intro={<div data-testid="my-intro">Welcome</div>}
      />,
    );
    const intro = screen.getByTestId('my-intro');
    const wrapper = intro.parentElement;
    expect(wrapper?.className).toContain('px-4');
    // The empty-list placeholder must also align at the same gutter.
    expect(screen.getByTestId('empty-message-list').className).toContain('px-4');
    void container;
  });

  it('wraps the with-messages intro in px-4 too (matches the empty-state padding so messages and intro line up)', () => {
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        intro={<div data-testid="my-intro">Welcome</div>}
      />,
    );
    const intro = screen.getByTestId('my-intro');
    const wrapper = intro.parentElement;
    expect(wrapper?.className).toContain('px-4');
  });

});

// MessageList Virtuoso wiring contract: locks the props + scroll calls
// the implementation must drive Virtuoso with on every code path the
// user has reported broken in past iterations. If these fail, the
// implementation is wrong — do not loosen the assertions.
async function renderAndCaptureVirtuoso(
  ui: React.ReactElement,
): Promise<Captured> {
  renderWithProviders(ui);
  // The deep-link scrollToIndex fires inside requestAnimationFrame.
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  return captured;
}

describe('MessageList Virtuoso wiring (regression contract)', () => {
  it('deep-link mount: initialTopMostItemIndex points at the anchor row index with center alignment', async () => {
    const m1 = makeMessage({ id: 'msg-old', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-anchor', createdAt: '2026-04-24T10:30:00Z' });
    const m3 = makeMessage({ id: 'msg-new', createdAt: '2026-04-24T11:00:00Z' });
    // Pages are newest-first per the API contract; MessageList
    // reverses to chronological. Day divider lands first; anchor
    // is the second message → row index 2.
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    );
    expect(captured.initialTopMostItemIndex).toEqual({ index: 2, align: 'center' });
  });

  it('deep-link mount: scrollToIndex is invoked with the anchor row index after a frame', async () => {
    const m1 = makeMessage({ id: 'msg-a', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-anchor', createdAt: '2026-04-24T10:30:00Z' });
    const m3 = makeMessage({ id: 'msg-c', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    );
    expect(captured.scrollToIndexCalls).toContainEqual({ index: 2, align: 'center' });
  });

  it('deep-link mount: scrollToIndex is a single correction, not a timer chase', async () => {
    const m1 = makeMessage({ id: 'msg-a', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-anchor', createdAt: '2026-04-24T10:30:00Z' });
    const m3 = makeMessage({ id: 'msg-c', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    );
    // Wait past the old 100/350/800ms chase. Smooth chat scrolling
    // relies on Virtuoso measurement, not repeated imperative scrolls.
    await new Promise((r) => setTimeout(r, 850));
    const anchorCalls = captured.scrollToIndexCalls.filter(
      (c) => c.index === 2 && c.align === 'center',
    );
    expect(anchorCalls).toHaveLength(1);
  });

  it('deep-link forward pagination: followOutput=false while hasPreviousPage=true (prevents spam-scroll on append)', async () => {
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-1"
      />
    );
    expect(captured.followOutput).toBe(false);
  });

  it('live-tail mount (no anchor): initialTopMostItemIndex is the last row index with end alignment', async () => {
    const m1 = makeMessage({ id: 'msg-a', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-b', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderAndCaptureVirtuoso(
      <MessageList {...defaultProps} pages={[{ items: [m2, m1] }]} hasPreviousPage={false} />
    );
    // Two messages on the same day → 1 day divider + 2 messages
    // = 3 rows; last row index is 2.
    expect(captured.initialTopMostItemIndex).toEqual({ index: 2, align: 'end' });
  });

  it('live-tail mount: followOutput follows only while Virtuoso reports bottom', async () => {
    const captured = await renderAndCaptureVirtuoso(
      <MessageList {...defaultProps} pages={[{ items: [makeMessage()] }]} hasPreviousPage={false} />
    );
    expect(captured.followOutput).toEqual(expect.any(Function));
    const followOutput = captured.followOutput as (isAtBottom: boolean) => false | 'auto';
    expect(followOutput(true)).toBe('auto');
    expect(followOutput(false)).toBe(false);
  });

  it('deep-link mount: scrollToIndex(LAST) is NEVER called — the resize-snap-to-bottom logic must not fight the anchor scroll', async () => {
    // Regression: manual bottom snapping yanked deep-linked users
    // away from their anchor. The component may perform the single
    // anchor correction, but it must not scroll to the live tail.
    const m1 = makeMessage({ id: 'msg-a', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-anchor', createdAt: '2026-04-24T10:30:00Z' });
    const m3 = makeMessage({ id: 'msg-c', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    );
    // Wait long enough for the old multi-pass timer chase to fire if
    // it were reintroduced.
    await new Promise((r) => setTimeout(r, 400));
    const lastCalls = captured.scrollToIndexCalls.filter((c) => c.index === 'LAST');
    expect(lastCalls).toEqual([]);
    // And the anchor scroll DID happen.
    expect(captured.scrollToIndexCalls).toContainEqual({ index: 2, align: 'center' });
  });

  it('does not attach a manual ResizeObserver for scroll correction', async () => {
    const observeCalls: Element[] = [];
    class TrackingRO {
      observe(el: Element) {
        observeCalls.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    const original = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
    (globalThis as unknown as { ResizeObserver: typeof TrackingRO }).ResizeObserver = TrackingRO;
    try {
      await renderAndCaptureVirtuoso(
        <MessageList
          {...defaultProps}
          pages={[{ items: [makeMessage()] }]}
          hasPreviousPage={false}
        />
      );
      expect(observeCalls).toEqual([]);
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    }
  });

  it('deep-link mount: does NOT scroll to the last row even if it is the current user\'s own message', async () => {
    // Regression: a deep-link's around-window may include the
    // user's own message in its newer half. That bottom is the end
    // of the loaded slice, not necessarily the live channel tail.
    const m1 = makeMessage({ id: 'msg-a', authorID: 'user-2', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-anchor', authorID: 'user-2', createdAt: '2026-04-24T10:30:00Z' });
    // m3 is the bottom of the around-window AND is the current
    // user's own message. defaultProps.currentUserId === 'user-1'.
    const m3 = makeMessage({ id: 'msg-own', authorID: 'user-1', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    );
    await new Promise((r) => setTimeout(r, 50));
    // No scroll-to-end (last row index is 3 with 3 messages + 1 day divider).
    const endCalls = captured.scrollToIndexCalls.filter((c) => c.align === 'end');
    expect(endCalls).toEqual([]);
  });

  it('live-tail mount: does not imperatively scroll just because the initial bottom message is own-authored', async () => {
    const m1 = makeMessage({ id: 'msg-a', authorID: 'user-2', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-own', authorID: 'user-1', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderAndCaptureVirtuoso(
      <MessageList {...defaultProps} pages={[{ items: [m2, m1] }]} hasPreviousPage={false} />
    );
    await new Promise((r) => setTimeout(r, 50));
    const endCalls = captured.scrollToIndexCalls.filter((c) => c.align === 'end');
    expect(endCalls).toEqual([]);
  });

  it('appending the current user\'s own message performs one explicit scroll to bottom', async () => {
    const m1 = makeMessage({ id: 'msg-a', authorID: 'user-2', createdAt: '2026-04-24T10:00:00Z' });
    const { rerender } = renderWithProviders(
      <MessageList {...defaultProps} pages={[{ items: [m1] }]} hasPreviousPage={false} />,
    );
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    captured.scrollToIndexCalls.length = 0;

    const m2 = makeMessage({ id: 'msg-own', authorID: 'user-1', createdAt: '2026-04-24T11:00:00Z' });
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <BrowserRouter>
          <MessageList {...defaultProps} pages={[{ items: [m2, m1] }]} hasPreviousPage={false} />
        </BrowserRouter>
      </QueryClientProvider>,
    );
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));

    expect(captured.scrollToIndexCalls).toEqual([{ index: 'LAST', align: 'end' }]);
  });

  it('uses Virtuoso-native stability props instead of manual scroll correction', async () => {
    const captured = await renderAndCaptureVirtuoso(
      <MessageList {...defaultProps} pages={[{ items: [makeMessage()] }]} hasPreviousPage={false} />
    );
    expect(captured.alignToBottom).toBe(true);
    expect(captured.defaultItemHeight).toBe(88);
    expect(captured.atBottomThreshold).toBe(4);
    // Wide overscan keeps ~2 screens of rows mounted off-viewport so
    // fast scrolling doesn't tear down and remount avatars / Giphy
    // embeds / unfurl cards on every off-screen → on-screen transition.
    expect(captured.increaseViewportBy).toEqual({ top: 2000, bottom: 2000 });
    expect(captured.computeItemKey?.(0, { key: 'stable-key' })).toBe('stable-key');
  });

  it('auto-sticks only for true live-tail bottom cases', () => {
    expect(shouldAutoStickMessageList({
      atBottom: false,
    })).toBe(false);
    expect(shouldAutoStickMessageList({
      atBottom: true,
    })).toBe(true);
    expect(shouldAutoStickMessageList({
      atBottom: true,
      hasPreviousPage: true,
    })).toBe(false);
    expect(shouldAutoStickMessageList({
      atBottom: true,
      anchorMsgId: 'msg-anchor',
    })).toBe(false);
    expect(shouldAutoStickMessageList({
      atBottom: true,
      autoStickSuppressed: true,
    })).toBe(false);
  });

  it('startReached fetches older pages only when ready and not already fetching', async () => {
    const fetchNextPage = vi.fn();
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasNextPage={true}
        isFetchingNextPage={false}
        fetchNextPage={fetchNextPage}
      />,
    );
    await new Promise((r) => setTimeout(r, 300));
    captured.startReached?.();
    expect(fetchNextPage).toHaveBeenCalledTimes(1);

    fetchNextPage.mockClear();
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage({ id: 'busy' })] }]}
        hasNextPage={true}
        isFetchingNextPage={true}
        fetchNextPage={fetchNextPage}
      />,
    );
    captured.startReached?.();
    expect(fetchNextPage).not.toHaveBeenCalled();
  });

  it('endReached fetches newer pages only when configured and idle', async () => {
    const fetchPreviousPage = vi.fn();
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasPreviousPage={true}
        isFetchingPreviousPage={false}
        fetchPreviousPage={fetchPreviousPage}
        anchorMsgId="msg-1"
      />,
    );
    await new Promise((r) => setTimeout(r, 300));
    captured.endReached?.();
    expect(fetchPreviousPage).toHaveBeenCalledTimes(1);

    fetchPreviousPage.mockClear();
    renderWithProviders(
      <MessageList
        {...defaultProps}
        pages={[{ items: [makeMessage({ id: 'busy-newer' })] }]}
        hasPreviousPage={true}
        isFetchingPreviousPage={true}
        fetchPreviousPage={fetchPreviousPage}
        anchorMsgId="busy-newer"
      />,
    );
    captured.endReached?.();
    expect(fetchPreviousPage).not.toHaveBeenCalled();
  });

  // Regression: deep-link scroll-to-newer flow used to be covered
  // piecewise but no test walked the whole chain end-to-end. The
  // failure mode was: user lands on a deep link, scrolls down to load
  // newer pages, the second fetch fires, the data lands — but the
  // rendered Virtuoso `data` prop didn't pick it up because the
  // append branch of `nextVirtuosoState` was returning early. Lock
  // every step here so any future regression at any link in the chain
  // surfaces a clearly-named failure.
  it('deep-link → endReached → fetchPreviousPage → newer rows render via rerender', async () => {
    const anchor = makeMessage({ id: 'msg-anchor', createdAt: '2026-04-24T10:00:00Z' });
    const newerA = makeMessage({ id: 'msg-newer-a', createdAt: '2026-04-24T10:01:00Z' });
    const fetchPreviousPage = vi.fn();
    // Share a single QueryClient across the initial + rerender calls
    // so the MessageItem mutations resolve their context across both
    // renders. We hand-wire providers here (the helper would build a
    // fresh QueryClient on each rerender, which loses the tree).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (node: React.ReactElement) => (
      <QueryClientProvider client={qc}>
        <BrowserRouter>{node}</BrowserRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(
      wrap(
        <MessageList
          {...defaultProps}
          // API returns newest-first; MessageList reverses to chrono.
          pages={[{ items: [newerA, anchor] }]}
          hasPreviousPage={true}
          isFetchingPreviousPage={false}
          fetchPreviousPage={fetchPreviousPage}
          anchorMsgId="msg-anchor"
        />,
      ),
    );
    // Past the readyForFetchRef 250ms guard.
    await new Promise((r) => setTimeout(r, 300));

    // Scroll-to-end fires fetchPreviousPage.
    captured.endReached?.();
    expect(fetchPreviousPage).toHaveBeenCalledTimes(1);

    // Server returns more newer messages → pages get a second window
    // appended at the front (newest-first) so the chronological tail
    // grows. Rerender with the appended data.
    const newerB = makeMessage({ id: 'msg-newer-b', createdAt: '2026-04-24T10:02:00Z' });
    const newerC = makeMessage({ id: 'msg-newer-c', createdAt: '2026-04-24T10:03:00Z' });
    rerender(
      wrap(
        <MessageList
          {...defaultProps}
          pages={[{ items: [newerC, newerB] }, { items: [newerA, anchor] }]}
          hasPreviousPage={false}
          isFetchingPreviousPage={false}
          fetchPreviousPage={fetchPreviousPage}
          anchorMsgId="msg-anchor"
        />,
      ),
    );
    // Wait one frame for the layout-effect to push the new rows into
    // Virtuoso's `data` prop atomically with firstItemIndex.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
    const renderedKeys = (captured.data ?? []).map((row) => (row as { key?: string }).key);
    expect(renderedKeys).toContain('msg-anchor');
    expect(renderedKeys).toContain('msg-newer-a');
    expect(renderedKeys).toContain('msg-newer-b');
    expect(renderedKeys).toContain('msg-newer-c');

    // Now that the live tail is reached, endReached must not refetch.
    fetchPreviousPage.mockClear();
    captured.endReached?.();
    expect(fetchPreviousPage).not.toHaveBeenCalled();
  });

  it('itemContent handles missing rows, day dividers, system messages, and unknown authors', async () => {
    const root = makeMessage({ id: 'root', authorID: 'missing-user', replyCount: 1 });
    const reply = makeMessage({
      id: 'reply',
      authorID: 'user-2',
      parentMessageID: 'root',
      createdAt: '2026-04-24T10:35:00Z',
    });
    const captured = await renderAndCaptureVirtuoso(
      <MessageList
        {...defaultProps}
        pages={[{ items: [reply, root, makeMessage({ id: 'sys', system: true, body: 'joined' })] }]}
        hasPreviousPage={false}
      />,
    );

    expect(captured.itemContent?.(0, undefined)).toBeNull();
    renderWithProviders(<>{captured.itemContent?.(0, { kind: 'day', key: 'd', date: '2026-04-24' })}</>);
    expect(screen.getAllByTestId('day-divider').at(-1)).toHaveTextContent('Apr 24th');
    renderWithProviders(
      <>{captured.itemContent?.(1, { kind: 'message', key: 'sys', message: makeMessage({ id: 'sys-2', system: true, body: 'joined again' }) })}</>,
    );
    expect(screen.getAllByRole('status').at(-1)).toHaveTextContent('joined again');
    renderWithProviders(<>{captured.itemContent?.(2, { kind: 'message', key: 'root', message: root })}</>);
    expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);
  });
});
