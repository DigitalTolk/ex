import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { createElement, forwardRef, useImperativeHandle, type ComponentType, type ReactNode, type Ref } from 'react';
import { MessageList } from './MessageList';
import { endReadSession, getUnreadAnchor, isAtLiveTail, noteMissedArrival, setAtBottom, setUnreadAnchor, isUnreadSeen } from '@/lib/read-position';
import { queryKeys } from '@/lib/query-keys';
import type { Message } from '@/types';

// The "New messages" line, banner and pill. Virtuoso is replaced by a mock
// that hands MessageList a real scroller element with controllable geometry,
// renders only a chosen window of rows (virtualization), and records every
// scrollToIndex — so the landing, re-aim, banner and jump logic can be driven
// deterministically.

type ListProps = {
  data?: unknown[];
  firstItemIndex?: number;
  itemContent?: (index: number, row?: unknown) => ReactNode;
  components?: { Header?: ComponentType; Footer?: ComponentType };
  scrollerRef?: (el: HTMLElement | null) => void;
  rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
  itemsRendered?: (items: unknown[]) => void;
  startReached?: (index: number) => void;
};
const list = vi.hoisted(() => ({
  props: {} as ListProps,
  scrollCalls: [] as Array<{ index: number | string; align?: string }>,
  // Rendered window of data indexes (null = every row is mounted).
  window: null as null | [number, number],
}));

vi.mock('react-virtuoso', () => {
  const Virtuoso = forwardRef((props: ListProps, ref: Ref<unknown>) => {
    list.props = props;
    useImperativeHandle(ref, () => ({
      scrollToIndex: (arg: { index: number | string; align?: string }) => list.scrollCalls.push(arg),
    }));
    const rows = (props.data ?? []).map((row, index) =>
      list.window && (index < list.window[0] || index > list.window[1])
        ? null
        : createElement('div', { key: index, 'data-row': index }, props.itemContent?.(index, row)),
    );
    return createElement('div', { 'data-testid': 'scroller', ref: (el: HTMLElement | null) => props.scrollerRef?.(el) }, ...rows);
  });
  return { Virtuoso };
});
vi.mock('@/hooks/useMarkUnread', () => ({ useMarkUnread: () => ({ mutate: vi.fn() }) }));

// Geometry: the viewport is 0..500; the line's box is whatever a test sets.
const geo = { lineTop: 100, scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 };
const realRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  list.props = {};
  list.scrollCalls.length = 0;
  list.window = null;
  Object.assign(geo, { lineTop: 100, scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 });
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
    if (this.hasAttribute('data-unread-divider')) return { top: geo.lineTop, bottom: geo.lineTop + 20 } as DOMRect;
    if (this.dataset.testid === 'scroller') return { top: 0, bottom: 500 } as DOMRect;
    return realRect.call(this);
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
});
afterEach(() => {
  cleanup(); // unmount before clearing the store, so no update lands outside act
  HTMLElement.prototype.getBoundingClientRect = realRect;
  endReadSession('ch-1');
  vi.useRealTimers();
});

function scroller(): HTMLElement {
  const el = screen.getByTestId('scroller');
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geo.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => geo.clientHeight });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => geo.scrollTop, set: (v) => (geo.scrollTop = v) });
  return el;
}

const frames = (n = 4) => act(() => vi.advanceTimersByTime(17 * n));
// Scroll the user to a position, firing the list's scroll listener.
function scrollTo(top: number) {
  geo.scrollTop = top;
  act(() => {
    fireEvent.scroll(scroller());
    vi.advanceTimersByTime(17);
  });
}

const msg = (n: number, over: Partial<Message> = {}): Message => ({
  id: `m-${String(n).padStart(2, '0')}`,
  parentID: 'ch-1',
  authorID: 'u-2',
  body: `message ${n}`,
  createdAt: `2026-10-07T09:${String(n).padStart(2, '0')}:00Z`,
  ...over,
});
// Pages are newest-first.
const pageOf = (from: number, to: number) => ({ items: Array.from({ length: to - from + 1 }, (_, i) => msg(to - i)) });

const base = {
  isLoading: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  currentUserId: 'u-1',
  channelId: 'ch-1',
  userMap: {},
};
type Props = Partial<Parameters<typeof MessageList>[0]>;
function renderList(props: Props = {}, qc = new QueryClient()) {
  const ui = (p: Props) => (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <MessageList {...base} pages={[pageOf(1, 10)]} {...p} />
      </BrowserRouter>
    </QueryClientProvider>
  );
  const view = render(ui(props));
  scroller();
  return { ...view, rerenderList: (p: Props) => view.rerender(ui({ ...props, ...p })) };
}
const lineIndex = () => (list.props.data as Array<{ kind: string }>).findIndex((r) => r.kind === 'unread');
const lineAbove = () => screen.getByTestId('unread-divider').closest('[data-row]')?.nextElementSibling?.textContent;

describe('MessageList unread line', () => {
  it('opening with unread: resolves the count to a message, freezes it, and lands on the tail', () => {
    setUnreadAnchor('ch-1', { kind: 'count', count: 3 });
    renderList();
    frames();
    expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'message', messageID: 'm-08' });
    expect(lineAbove()).toContain('message 8');
    expect(list.scrollCalls).toContainEqual({ index: 'LAST', align: 'end' });
    expect(list.scrollCalls).not.toContainEqual({ index: lineIndex(), align: 'start' });
  });

  it('Jump re-aims while the line is still off screen, up to the attempt cap', () => {
    geo.lineTop = -300; // above the viewport: the banner offers Jump
    const onAtBottomChange = vi.fn();
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-04' });
    renderList({ onAtBottomChange });
    frames();
    geo.scrollTop = 1000; // the aims leave the list 500px above the tail
    list.scrollCalls.length = 0;
    fireEvent.click(screen.getByTestId('unread-banner-jump'));
    frames(12); // the line never comes on screen (geo.lineTop stays put)
    expect(list.scrollCalls.filter((c) => c.align === 'start')).toHaveLength(3);
    expect(onAtBottomChange).toHaveBeenCalledWith(false);
  });

  it('the settle window ends on its own', () => {
    setUnreadAnchor('ch-1', { kind: 'count', count: 3 });
    const view = renderList();
    frames();
    act(() => vi.advanceTimersByTime(2500));
    const settled = list.scrollCalls.length;
    view.rerenderList({ pages: [pageOf(1, 10), pageOf(-4, 0)] });
    frames();
    expect(list.scrollCalls).toHaveLength(settled);
  });

  it('a deep-link anchor wins over landing on the line', () => {
    setUnreadAnchor('ch-1', { kind: 'count', count: 3 });
    renderList({ anchorMsgId: 'm-02' });
    frames();
    expect(list.scrollCalls.some((c) => c.align === 'start')).toBe(false);
  });

  it('drawing the line while following the tail keeps the tail pinned; scrolled up it does not', () => {
    renderList();
    act(() => setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-07' }));
    frames();
    expect(list.scrollCalls).toContainEqual({ index: 'LAST', align: 'end' });

    list.scrollCalls.length = 0;
    fireEvent.wheel(scroller()); // the person takes over: ends the opening settle
    scrollTo(200); // scroll up: no longer following the tail
    act(() => setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-05' }, { replace: true }));
    frames();
    expect(list.scrollCalls).not.toContainEqual({ index: 'LAST', align: 'end' });
  });
});

describe('MessageList unread banner + pill', () => {
  it('banner while the line is above the view: Jump back, or mark it all read', () => {
    const onMarkAllRead = vi.fn();
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-04' });
    geo.lineTop = -300;
    renderList({ onMarkAllRead });
    frames();
    expect(screen.getByTestId('unread-banner')).toHaveTextContent('7 new messages');
    list.scrollCalls.length = 0;
    fireEvent.click(screen.getByTestId('unread-banner-jump'));
    frames();
    expect(list.scrollCalls[0]).toEqual({ index: lineIndex(), align: 'start' });
    fireEvent.click(screen.getByTestId('unread-banner-mark-read'));
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
  });

  it('pill while the line is below the view; clicking it goes to the tail', () => {
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-09' });
    geo.lineTop = 800;
    renderList();
    frames();
    expect(screen.getByTestId('unread-below-pill')).toHaveTextContent('2 new messages');
    fireEvent.click(screen.getByTestId('unread-below-pill'));
    expect(list.scrollCalls).toContainEqual({ index: 'LAST', align: 'end' });
  });

  it('a line on screen shows neither', () => {
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-09' });
    renderList();
    frames();
    expect(screen.queryByTestId('unread-banner')).toBeNull();
    expect(screen.queryByTestId('unread-below-pill')).toBeNull();
  });

  it('virtualized away: judged from the rendered range', () => {
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-02' });
    list.window = [8, 20]; // the line's row isn't mounted
    renderList();
    frames();
    expect(screen.queryByTestId('unread-banner')).toBeNull(); // no range reported yet
    const first = list.props.firstItemIndex ?? 0;
    act(() => list.props.rangeChanged?.({ startIndex: first + 8, endIndex: first + 20 }));
    frames();
    expect(screen.getByTestId('unread-banner')).toBeInTheDocument();
    act(() => list.props.rangeChanged?.({ startIndex: first, endIndex: first + 1 }));
    act(() => list.props.itemsRendered?.([]));
    frames();
    expect(screen.getByTestId('unread-below-pill')).toBeInTheDocument();
  });

  it('retires once the user comes back down to the tail', () => {
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-04' });
    geo.lineTop = -300;
    const onAtBottomChange = vi.fn();
    renderList({ onAtBottomChange });
    frames();
    scrollTo(800);
    expect(screen.getByTestId('unread-banner')).toBeInTheDocument();
    scrollTo(1500); // scrollHeight - clientHeight: the tail
    frames();
    expect(onAtBottomChange.mock.calls.map(([v]) => v)).toEqual([false, true]);
    expect(screen.queryByTestId('unread-banner')).toBeNull();
  });

  it('nothing unread after the line, or no line: no markers', () => {
    setUnreadAnchor('ch-1', { kind: 'count', count: 0 });
    renderList();
    frames();
    expect(screen.queryByTestId('unread-banner')).toBeNull();
    act(() => endReadSession('ch-1'));
    frames();
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });
});

describe('MessageList unread Jump past the loaded history', () => {
  it('pages back until the line loads, then scrolls to it', () => {
    const fetchNextPage = vi.fn();
    setUnreadAnchor('ch-1', { kind: 'count', count: 14 });
    const view = renderList({ hasNextPage: true, fetchNextPage });
    frames();
    expect(screen.getByTestId('unread-banner')).toHaveTextContent('14 new messages');
    fireEvent.click(screen.getByTestId('unread-banner-jump'));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
    view.rerenderList({ hasNextPage: true, fetchNextPage, isFetchingNextPage: true });
    view.rerenderList({ hasNextPage: true, fetchNextPage, isFetchingNextPage: false, pages: [pageOf(1, 10), pageOf(-4, 0)] });
    frames();
    expect(lineAbove()).toContain('message -3');
    expect(list.scrollCalls.at(-1)).toEqual({ index: lineIndex(), align: 'start' });
  });

  it('gives up at the page cap, or when history runs out, and goes to the top', () => {
    const fetchNextPage = vi.fn();
    setUnreadAnchor('ch-1', { kind: 'count', count: 500 });
    const view = renderList({ hasNextPage: true, fetchNextPage });
    frames();
    fireEvent.click(screen.getByTestId('unread-banner-jump'));
    // Each fetch settles without the line turning up.
    for (let i = 0; i < 24; i++) {
      view.rerenderList({ hasNextPage: true, fetchNextPage, isFetchingNextPage: i % 2 === 0 });
    }
    expect(fetchNextPage).toHaveBeenCalledTimes(10);
    frames();
    expect(list.scrollCalls.at(-1)).toEqual({ index: 0, align: 'start' });

    list.scrollCalls.length = 0;
    view.rerenderList({ hasNextPage: false, fetchNextPage });
    fireEvent.click(screen.getByTestId('unread-banner-jump'));
    frames();
    expect(list.scrollCalls.at(-1)).toEqual({ index: 0, align: 'start' });
  });
});

describe('MessageList window opened from a link', () => {
  it('counts arrivals it cannot show in a pill to the newest; reaching the live tail forgets them', () => {
    const onJumpToLatest = vi.fn();
    // Like the read session: it records where the list stands.
    const onAtBottomChange = vi.fn((atBottom: boolean) => setAtBottom('ch-1', atBottom));
    const view = renderList({ hasPreviousPage: true, onJumpToLatest, onAtBottomChange });
    frames();
    expect(isAtLiveTail('ch-1')).toBe(false);
    expect(onAtBottomChange).toHaveBeenCalledWith(false); // the window's end isn't the chat's
    expect(screen.queryByTestId('unread-below-pill')).toBeNull();
    act(() => {
      noteMissedArrival('ch-1');
      noteMissedArrival('ch-1');
    });
    fireEvent.click(screen.getByTestId('unread-below-pill'));
    expect(onJumpToLatest).toHaveBeenCalledTimes(1);
    view.rerenderList({ hasPreviousPage: false });
    frames();
    expect(isAtLiveTail('ch-1')).toBe(true);
    expect(screen.queryByTestId('unread-below-pill')).toBeNull();
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
  });

  it('a list outside any chat (no read position) tracks nothing', () => {
    renderList({ channelId: undefined, hasPreviousPage: true });
    frames();
    expect(isAtLiveTail('ch-1')).toBe(true);
  });

  it('the pill is harmless without a jump handler', () => {
    renderList({ hasPreviousPage: true });
    frames();
    act(() => noteMissedArrival('ch-1'));
    fireEvent.click(screen.getByTestId('unread-below-pill'));
    expect(screen.getByTestId('unread-below-pill')).toBeInTheDocument();
  });

  it('does not place a count line inside older history: it is resolved at the newest', () => {
    setUnreadAnchor('ch-1', { kind: 'count', count: 3 });
    renderList({ hasPreviousPage: true });
    frames();
    expect(getUnreadAnchor('ch-1')).toEqual({ kind: 'count', count: 3 });
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });
});

describe('MessageList unread line retires', () => {
  it('once the line has been seen (the divider reports it) the banner goes and the row stays, invisible', () => {
    type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
    const callbacks: IOCallback[] = [];
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: IOCallback) { callbacks.push(cb); }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    });
    try {
      setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-04' });
      geo.lineTop = -300; // above the view: the banner is up
      renderList();
      frames();
      expect(screen.getByTestId('unread-banner')).toBeInTheDocument();
      act(() => callbacks[0]([{ isIntersecting: true }]));
      act(() => vi.advanceTimersByTime(3500));
      expect(isUnreadSeen('ch-1')).toBe(true);
      expect(screen.queryByTestId('unread-banner')).toBeNull();
      expect(screen.getByTestId('unread-divider')).toHaveAttribute('data-retired', 'true');
      expect(lineAbove()).toContain('message 4');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('MessageList row memo and thread meta', () => {
  it('re-renders a root only when its thread meta really changes', () => {
    const reply = (n: number, authorID: string) => msg(n, { parentMessageID: 'm-05', authorID });
    const withRoot = (items: Message[], replyCount: number) =>
      items.map((m) => (m.id === 'm-05' ? { ...m, replyCount } : m));
    const view = renderList({ pages: [{ items: withRoot(pageOf(1, 10).items, 0) }] });
    frames();
    expect(screen.queryByTestId('thread-action-bar')).toBeNull();
    // A first reply: the root gains thread meta (entry appears).
    view.rerenderList({ pages: [{ items: [reply(11, 'u-3'), ...withRoot(pageOf(1, 10).items, 1)] }] });
    frames();
    expect(screen.getByTestId('thread-action-bar')).toHaveTextContent('1 reply');
    // An unrelated message: the meta Map is rebuilt with the same entry, which must not count as a change.
    view.rerenderList({ pages: [{ items: [msg(12), reply(11, 'u-3'), ...withRoot(pageOf(1, 10).items, 1)] }] });
    frames();
    expect(screen.getByTestId('thread-action-bar')).toHaveTextContent('1 reply');
    // A second reply from someone else: authors and last-reply time change.
    view.rerenderList({ pages: [{ items: [reply(13, 'u-4'), msg(12), reply(11, 'u-3'), ...withRoot(pageOf(1, 10).items, 2)] }] });
    frames();
    expect(screen.getByTestId('thread-action-bar')).toHaveTextContent('2 replies');
  });
});

describe('MessageList thread reply bars', () => {
  it('marks the bar of a thread with unread replies', () => {
    const qc = new QueryClient();
    const thread = (id: string) => ({
      parentID: 'ch-1', parentType: 'channel', threadRootID: id, rootAuthorID: 'u-2', rootBody: '',
      rootCreatedAt: '2026-10-07T09:00:00Z', replyCount: 2, latestActivityAt: '2026-10-07T10:00:00Z',
    });
    qc.setQueryData(queryKeys.userThreads(), [thread('m-05'), thread('m-06')]);
    qc.setQueryData(queryKeys.userState(), { threadNotifications: ['m-05'] });
    const items = pageOf(1, 10).items.map((m) =>
      m.id === 'm-05' || m.id === 'm-06' ? { ...m, replyCount: 2, recentReplyAuthorIDs: ['u-2'] } : m,
    );
    renderList({ pages: [{ items }] }, qc);
    frames();
    const bars = screen.getAllByTestId('thread-action-bar');
    expect(bars.map((b) => b.getAttribute('data-new'))).toEqual(['true', null]);
  });
});


describe('MessageList opened on a linked message', () => {
  // Virtuoso asks for older history the moment a link lands; inserting it
  // above the message shifted the view (to the bottom, in a short chat). It
  // waits until the person scrolls up.
  it('keeps the older page back until the person scrolls up, then loads it once', () => {
    const fetchNextPage = vi.fn();
    renderList({ anchorMsgId: 'm-05', anchorRevision: 'nav-1', hasNextPage: true, fetchNextPage });
    act(() => list.props.startReached?.(0));
    expect(fetchNextPage).not.toHaveBeenCalled();
    // The list moving on its own (no hand on it) doesn't count, either way.
    scrollTo(1400);
    scrollTo(1300);
    expect(fetchNextPage).not.toHaveBeenCalled();
    // The person scrolling down doesn't need it…
    fireEvent.wheel(scroller());
    scrollTo(1450);
    expect(fetchNextPage).not.toHaveBeenCalled();
    // …scrolling up loads it, once.
    scrollTo(1350);
    scrollTo(1250);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('opening the link again holds it again; jumping to the unread line lets go', () => {
    const fetchNextPage = vi.fn();
    setUnreadAnchor('ch-1', { kind: 'message', messageID: 'm-08' });
    const view = renderList({ anchorMsgId: 'm-05', anchorRevision: 'nav-1', hasNextPage: true, fetchNextPage });
    fireEvent.wheel(scroller());
    view.rerenderList({ anchorRevision: 'nav-2' });
    act(() => list.props.startReached?.(0));
    expect(fetchNextPage).not.toHaveBeenCalled();
    geo.lineTop = -200;
    scrollTo(1400);
    fireEvent.click(screen.getByTestId('unread-banner-jump'));
    scrollTo(1300);
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('without a link, older history loads as soon as it is asked for', () => {
    const fetchNextPage = vi.fn();
    renderList({ hasNextPage: true, fetchNextPage });
    act(() => list.props.startReached?.(0));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});

describe('MessageList cover while the first rows paint', () => {
  // Virtuoso mounts empty and measures before painting any rows; the loading
  // skeletons stay over it until rows are rendered, so no blank pane shows.
  const cover = () => screen.queryByTestId('message-list-cover');

  it('stays until rows are rendered, then lifts a frame later', () => {
    renderList();
    expect(cover()).toBeInTheDocument();
    act(() => list.props.itemsRendered?.([]));
    frames(2);
    expect(cover()).toBeInTheDocument();
    act(() => {
      list.props.itemsRendered?.([{}]);
      list.props.itemsRendered?.([{}]);
    });
    expect(cover()).toBeInTheDocument();
    frames(1);
    expect(cover()).toBeNull();
  });

  it('lifts on its own if rows never report, so it can never get stuck', () => {
    renderList();
    act(() => vi.advanceTimersByTime(1999));
    expect(cover()).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(cover()).toBeNull();
  });

  it('pulses in step with the loading skeletons shown before it', () => {
    renderList();
    const set = cover()!.firstElementChild as HTMLElement;
    expect(set.style.getPropertyValue('--pulse-delay')).toMatch(/^-\d+ms$/);
  });
});
