import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { createElement, forwardRef, useImperativeHandle, type ComponentType, type Ref } from 'react';
import { MessageList } from './MessageList';
import type { Message } from '@/types';
// ResizeObserver + offsetHeight/offsetWidth/clientHeight/clientWidth
// stubs are installed globally by frontend/src/test/setup.ts.

// Virtuoso mock: capture props + scrollToIndex calls for the regression
// contract tests, while still rendering Header/Footer and the
// [data-virtuoso-scroller] / [data-viewport-type] markers the resize-
// snap effect queries for. The captured object is module-scoped and
// reset per test in beforeEach.
type Captured = {
  initialTopMostItemIndex?: unknown;
  followOutput?: unknown;
  data?: unknown[];
  atBottomStateChange?: (atBottom: boolean) => void;
  scrollToIndexCalls: Array<{ index: number | string; align?: string }>;
};
const captured: Captured = { scrollToIndexCalls: [] };

vi.mock('react-virtuoso', () => {
  type VirtuosoMockProps = {
    initialTopMostItemIndex?: unknown;
    followOutput?: unknown;
    data?: unknown[];
    atBottomStateChange?: (atBottom: boolean) => void;
    components?: { Header?: ComponentType; Footer?: ComponentType };
  };
  const Virtuoso = forwardRef((props: VirtuosoMockProps, ref: Ref<unknown>) => {
    captured.initialTopMostItemIndex = props.initialTopMostItemIndex;
    captured.followOutput = props.followOutput;
    captured.data = props.data;
    captured.atBottomStateChange = props.atBottomStateChange;
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
      Footer ? createElement(Footer) : null,
    );
  });
  return { Virtuoso };
});

beforeEach(() => {
  captured.initialTopMostItemIndex = undefined;
  captured.followOutput = undefined;
  captured.data = undefined;
  captured.atBottomStateChange = undefined;
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

  it('deep-link mount: scrollToIndex is invoked MULTIPLE times so virtuoso can correct on real row measurements', async () => {
    // Regression: thread deep-links mount the ThreadPanel alongside
    // MessageList, narrowing the main scroller. Virtuoso's row-
    // height estimates are wrong at the narrower width, so a
    // single rAF scrollToIndex lands off-target. The fix is multi-
    // pass at 0/100/350/800ms — later passes re-assert position
    // once measurements have settled. This test asserts that at
    // least 4 anchor scrolls fire within ~1s (the no-op cost of
    // an already-on-target call is acceptable).
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
    // Wait for the last pass at 800ms to fire.
    await new Promise((r) => setTimeout(r, 850));
    const anchorCalls = captured.scrollToIndexCalls.filter(
      (c) => c.index === 2 && c.align === 'center',
    );
    expect(anchorCalls.length).toBeGreaterThanOrEqual(4);
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

  it('live-tail mount: followOutput="auto" so live WS messages stick when at bottom', async () => {
    const captured = await renderAndCaptureVirtuoso(
      <MessageList {...defaultProps} pages={[{ items: [makeMessage()] }]} hasPreviousPage={false} />
    );
    expect(captured.followOutput).toBe('auto');
  });

  it('deep-link mount: scrollToIndex(LAST) is NEVER called — the resize-snap-to-bottom logic must not fight the anchor scroll', async () => {
    // Regression: atBottomRef defaults to true; the ResizeObserver
    // attached on mount fired reSnap → scrollToIndex({index:'LAST'})
    // before atBottomStateChange had a chance to correct the ref to
    // false, yanking the deep-linked user away from their anchor.
    // The fix: skip the RO + multi-pass snap entirely when an
    // anchor is set. This test asserts the only scrollToIndex call
    // is the anchor scroll, not LAST.
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
    // Wait long enough for the multi-pass timer chase to fire if
    // it were enabled (the chase has timers at 0/100/350 ms).
    await new Promise((r) => setTimeout(r, 400));
    const lastCalls = captured.scrollToIndexCalls.filter((c) => c.index === 'LAST');
    expect(lastCalls).toEqual([]);
    // And the anchor scroll DID happen.
    expect(captured.scrollToIndexCalls).toContainEqual({ index: 2, align: 'center' });
  });

  it('deep-link mount: does NOT attach a ResizeObserver — the resize-snap effect must early-return before observe()', async () => {
    // Stronger regression coverage than the scrollToIndex check:
    // even if a future edit kept reSnap conditional on
    // atBottomRef (which defaults to true), an attached RO would
    // STILL fire on a real browser's first content-grew resize
    // and pull the user away from the anchor. The contract is
    // that the RO is not attached at all when anchorMsgId is set.
    //
    // We replace globalThis.ResizeObserver with an instrumented
    // stub for this test only, then restore it.
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
          hasPreviousPage={true}
          fetchPreviousPage={vi.fn()}
          anchorMsgId="msg-1"
        />
      );
      expect(observeCalls).toEqual([]);
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    }
  });

  it('deep-link mount: does NOT scroll to the last row even if it is the current user\'s own message (lastOwnBottomRef must be skipped)', async () => {
    // Regression: a deep-link's around-window may include the
    // user's own message in its newer half. Without the
    // anchorMsgId guard, lastOwnBottomRef saw "bottom of loaded
    // slice is own message" and scrolled to LAST end — yanking
    // the user away from their anchor.
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

  it('live-tail mount: lastOwnBottomRef DOES fire when no anchor is set and the bottom is the user\'s own message', async () => {
    // Companion to the deep-link test above: confirms the anchor
    // guard is conditional, not always-on. Without an anchor the
    // user's own message at the bottom should pull the view to it
    // (the canonical "I sent a message, scroll to it" behavior).
    const m1 = makeMessage({ id: 'msg-a', authorID: 'user-2', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-own', authorID: 'user-1', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderAndCaptureVirtuoso(
      <MessageList {...defaultProps} pages={[{ items: [m2, m1] }]} hasPreviousPage={false} />
    );
    await new Promise((r) => setTimeout(r, 50));
    const endCalls = captured.scrollToIndexCalls.filter((c) => c.align === 'end');
    expect(endCalls.length).toBeGreaterThan(0);
  });

  it('live-tail mount: content growth re-snaps during bottom intent, then user interaction cancels it', async () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    class TrackingRO {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const original = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
    (globalThis as unknown as { ResizeObserver: typeof TrackingRO }).ResizeObserver = TrackingRO;
    try {
      const captured = await renderAndCaptureVirtuoso(
        <MessageList {...defaultProps} pages={[{ items: [makeMessage()] }]} hasPreviousPage={false} />
      );
      const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller]');
      if (!scroller) throw new Error('missing mocked Virtuoso scroller');
      let scrollHeight = 100;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get: () => scrollHeight,
      });
      captured.atBottomStateChange?.(false);
      captured.scrollToIndexCalls.length = 0;

      scrollHeight = 200;
      resizeCallback?.(
        [{ target: scroller, contentRect: { width: 1024, height: 768 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(captured.scrollToIndexCalls).toContainEqual({ index: 'LAST', align: 'end' });

      fireEvent.wheel(scroller);
      captured.scrollToIndexCalls.length = 0;
      scrollHeight = 300;
      resizeCallback?.(
        [{ target: scroller, contentRect: { width: 1024, height: 768 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      expect(captured.scrollToIndexCalls).toEqual([]);
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    }
  });

  it('live-tail mount: DOES attach a ResizeObserver — needed to re-snap when the banner appears or content grows', async () => {
    // Companion to the deep-link test above: confirms the early
    // return is gated on anchorMsgId only, not always-on. The RO
    // must remain wired up for live-tail viewers.
    let observeCallCount = 0;
    class TrackingRO {
      observe() {
        observeCallCount++;
      }
      unobserve() {}
      disconnect() {}
    }
    const original = (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver;
    (globalThis as unknown as { ResizeObserver: typeof TrackingRO }).ResizeObserver = TrackingRO;
    try {
      await renderAndCaptureVirtuoso(
        <MessageList {...defaultProps} pages={[{ items: [makeMessage()] }]} hasPreviousPage={false} />
      );
      // The mocked Virtuoso renders [data-virtuoso-scroller] +
      // [data-viewport-type], so the live-tail RO setup observes
      // both. observeCallCount > 0 proves the anchorMsgId
      // early-return is conditional, not unconditional — the
      // companion to the deep-link "DOES NOT attach RO" test.
      expect(observeCallCount).toBeGreaterThan(0);
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = original;
    }
  });
});
