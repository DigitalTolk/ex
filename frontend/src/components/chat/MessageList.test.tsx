import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { MessageList } from './MessageList';
import type { Message } from '@/types';

// Virtuoso depends on ResizeObserver + element layout dimensions to
// decide which rows to render. jsdom reports zero for layout and
// doesn't ship a ResizeObserver, so without these stubs Virtuoso
// renders nothing visible. The component's wrappers (Header, Footer,
// empty placeholder) are rendered outside virtualization and stay
// testable here; assertions on the virtualized message rows live in
// the parent-component integration tests.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 50; } });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 1024; } });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 768; } });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1024; } });

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

// MessageList Virtuoso wiring contract
//
// These tests are the strict regression contract for how MessageList
// drives Virtuoso. Every behavior the user has reported as broken in
// past iterations is locked here so subsequent edits can't oscillate.
// If any of these fail, the implementation is wrong — do NOT loosen
// the assertions.
//
// Behaviors locked:
//
// 1. Deep-link mount → Virtuoso receives initialTopMostItemIndex
//    pointing at the anchor message's row index, with center align.
//    Without this the user lands at the wrong spot on first paint.
// 2. Deep-link mount → after a frame, scrollToIndex is called with
//    the anchor index and align:'center'. Belt-and-braces because
//    initialTopMostItemIndex is captured at mount time and may be
//    -1 if data hadn't arrived yet.
// 3. Deep-link forward pagination → followOutput is false while
//    hasPreviousPage=true. Otherwise each fetched newer page snaps
//    the user to the new bottom and re-arms endReached → spam.
// 4. Live-tail mount (no anchor) → initialTopMostItemIndex points at
//    the last row, align:'end'. Without this the user lands mid-list
//    on a fresh channel open.
// 5. Live-tail mount → followOutput='auto' so live WS messages stick
//    when the user is at the bottom.
//
// Each test imports MessageList behind a Virtuoso mock that captures
// the exact props the component passes.
type Captured = {
  initialTopMostItemIndex?: unknown;
  followOutput?: unknown;
  data?: unknown[];
  scrollToIndexCalls: Array<{ index: number | string; align?: string }>;
};

async function renderWithVirtuosoMock(
  ui: (Component: typeof MessageList) => React.ReactElement,
): Promise<Captured> {
  const captured: Captured = { scrollToIndexCalls: [] };
  vi.resetModules();
  vi.doMock('react-virtuoso', async () => {
    const React = await import('react');
    const Virtuoso = React.forwardRef(
      (
        props: {
          initialTopMostItemIndex?: unknown;
          followOutput?: unknown;
          data?: unknown[];
        },
        ref: React.Ref<unknown>,
      ) => {
        captured.initialTopMostItemIndex = props.initialTopMostItemIndex;
        captured.followOutput = props.followOutput;
        captured.data = props.data;
        React.useImperativeHandle(ref, () => ({
          scrollToIndex: (arg: { index: number | string; align?: string }) => {
            captured.scrollToIndexCalls.push(arg);
          },
        }));
        // Render the scroller + viewport markers the resize-snap
        // effect queries for. Without these, querySelector returns
        // null and the effect early-returns harmlessly — masking
        // any regression where the anchor-bail is removed.
        return React.createElement(
          'div',
          { 'data-virtuoso-scroller': true },
          React.createElement('div', { 'data-viewport-type': 'window' }),
        );
      },
    );
    return { Virtuoso };
  });
  const { MessageList: MessageListMocked } = await import('./MessageList');
  renderWithProviders(ui(MessageListMocked));
  // The deeplink scrollToIndex is queued in a RAF; flush it.
  await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  vi.doUnmock('react-virtuoso');
  vi.resetModules();
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
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    ));
    expect(captured.initialTopMostItemIndex).toEqual({ index: 2, align: 'center' });
  });

  it('deep-link mount: scrollToIndex is invoked with the anchor row index after a frame', async () => {
    const m1 = makeMessage({ id: 'msg-a', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-anchor', createdAt: '2026-04-24T10:30:00Z' });
    const m3 = makeMessage({ id: 'msg-c', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    ));
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
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    ));
    // Wait for the last pass at 800ms to fire.
    await new Promise((r) => setTimeout(r, 850));
    const anchorCalls = captured.scrollToIndexCalls.filter(
      (c) => c.index === 2 && c.align === 'center',
    );
    expect(anchorCalls.length).toBeGreaterThanOrEqual(4);
  });

  it('deep-link forward pagination: followOutput=false while hasPreviousPage=true (prevents spam-scroll on append)', async () => {
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML
        {...defaultProps}
        pages={[{ items: [makeMessage()] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-1"
      />
    ));
    expect(captured.followOutput).toBe(false);
  });

  it('live-tail mount (no anchor): initialTopMostItemIndex is the last row index with end alignment', async () => {
    const m1 = makeMessage({ id: 'msg-a', createdAt: '2026-04-24T10:00:00Z' });
    const m2 = makeMessage({ id: 'msg-b', createdAt: '2026-04-24T11:00:00Z' });
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML {...defaultProps} pages={[{ items: [m2, m1] }]} hasPreviousPage={false} />
    ));
    // Two messages on the same day → 1 day divider + 2 messages
    // = 3 rows; last row index is 2.
    expect(captured.initialTopMostItemIndex).toEqual({ index: 2, align: 'end' });
  });

  it('live-tail mount: followOutput="auto" so live WS messages stick when at bottom', async () => {
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML {...defaultProps} pages={[{ items: [makeMessage()] }]} hasPreviousPage={false} />
    ));
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
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    ));
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
      await renderWithVirtuosoMock((ML) => (
        <ML
          {...defaultProps}
          pages={[{ items: [makeMessage()] }]}
          hasPreviousPage={true}
          fetchPreviousPage={vi.fn()}
          anchorMsgId="msg-1"
        />
      ));
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
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML
        {...defaultProps}
        pages={[{ items: [m3, m2, m1] }]}
        hasPreviousPage={true}
        fetchPreviousPage={vi.fn()}
        anchorMsgId="msg-anchor"
      />
    ));
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
    const captured = await renderWithVirtuosoMock((ML) => (
      <ML {...defaultProps} pages={[{ items: [m2, m1] }]} hasPreviousPage={false} />
    ));
    await new Promise((r) => setTimeout(r, 50));
    const endCalls = captured.scrollToIndexCalls.filter((c) => c.align === 'end');
    expect(endCalls.length).toBeGreaterThan(0);
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
      await renderWithVirtuosoMock((ML) => (
        <ML {...defaultProps} pages={[{ items: [makeMessage()] }]} hasPreviousPage={false} />
      ));
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
