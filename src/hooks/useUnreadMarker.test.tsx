import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { useUnreadMarker } from './useUnreadMarker';
import { apiFetch } from '@/lib/api';
import { getReadThrough, setListAtBottom, useReadPositionStore } from '@/stores/read-position';
import type { Message } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

const LISTS: Record<string, unknown> = {};

beforeEach(() => {
  useReadPositionStore.setState({ atBottom: {}, readThrough: {}, ackedThrough: {} });
  vi.mocked(apiFetch).mockImplementation((path: string) =>
    Promise.resolve((LISTS[path] ?? undefined) as never),
  );
});

afterEach(() => {
  cleanup();
  vi.mocked(apiFetch).mockReset();
  for (const k of Object.keys(LISTS)) delete LISTS[k];
  vi.restoreAllMocks();
});

function m(id: string, overrides: Partial<Message> = {}): Message {
  return { id, parentID: 'ch-1', authorID: 'other', body: id, createdAt: '2026-09-24T10:00:00Z', ...overrides } as Message;
}

// Pages are newest-first, items newest-first (as the API returns them).
function pagesOf(...chronological: Message[]) {
  return [{ items: chronological.slice().reverse() }];
}

type Args = Parameters<typeof useUnreadMarker>[0];

function setup(initial: Partial<Args>, seed?: { channels?: unknown[]; conversations?: unknown[] }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (seed?.channels) {
    qc.setQueryData(['userChannels'], seed.channels);
    LISTS['/api/v1/channels'] = seed.channels;
  }
  if (seed?.conversations) {
    qc.setQueryData(['userConversations'], seed.conversations);
    LISTS['/api/v1/conversations'] = seed.conversations;
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const base: Args = {
    kind: 'channel',
    parentID: 'ch-1',
    pages: undefined,
    messagesLoaded: true,
    hasOlderPages: false,
    hasNewerPages: false,
    currentUserId: 'me',
    ...initial,
  };
  const hook = renderHook((props: Args) => useUnreadMarker(props), { wrapper, initialProps: base });
  return { ...hook, qc, base };
}

function readCalls(path = '/api/v1/channels/ch-1/read') {
  return vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === path);
}

describe('useUnreadMarker', () => {
  it('places the divider at the first unread, reads up to the newest on open, and keeps the divider', async () => {
    const { result } = setup(
      { pages: pagesOf(m('01A'), m('01B'), m('01C'), m('01D')) },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01B', unreadCount: 2 }] },
    );
    expect(result.current.dividerMsgId).toBe('01C');
    expect(result.current.count).toBe(2);
    expect(result.current.since).toBe('2026-09-24T10:00:00Z');
    expect(result.current.pending).toBe(false);
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    expect(readCalls()[0][1]).toEqual({ method: 'PUT', body: JSON.stringify({ upToMessageID: '01D' }) });
    // The local read point advanced, but the divider stays where the user left off.
    expect(getReadThrough('ch-1')).toBe('01D');
    expect(result.current.dividerMsgId).toBe('01C');
    expect(result.current.newCount).toBe(0);
  });

  it('is pending while the first unread is in an unloaded older page, then resolves', () => {
    const { result, rerender, base } = setup(
      { pages: pagesOf(m('01C'), m('01D')), hasOlderPages: true },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 3 }] },
    );
    expect(result.current.pending).toBe(true);
    expect(result.current.dividerMsgId).toBeUndefined();
    expect(result.current.count).toBe(3);
    rerender({ ...base, pages: pagesOf(m('01A'), m('01B'), m('01C'), m('01D')), hasOlderPages: true });
    expect(result.current.pending).toBe(false);
    expect(result.current.dividerMsgId).toBe('01B');
  });

  it('does not read while scrolled up; reads once the user reaches the bottom', async () => {
    setListAtBottom('ch-1', false);
    const { result } = setup(
      { pages: pagesOf(m('01A'), m('01B')) },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 1 }] },
    );
    expect(result.current.dividerMsgId).toBe('01B');
    expect(readCalls()).toHaveLength(0);
    act(() => setListAtBottom('ch-1', true));
    await waitFor(() => expect(readCalls()).toHaveLength(1));
  });

  it('a message arriving while scrolled up gets a fresh divider and counts toward the pill', async () => {
    const { result, rerender, base } = setup(
      { pages: pagesOf(m('01A'), m('01B')) },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01B', unreadCount: 0 }] },
    );
    expect(result.current.dividerMsgId).toBeUndefined();
    await waitFor(() => expect(getReadThrough('ch-1')).toBe('01B'));
    act(() => setListAtBottom('ch-1', false));
    rerender({ ...base, pages: pagesOf(m('01A'), m('01B'), m('01C')) });
    expect(result.current.dividerMsgId).toBe('01C');
    expect(result.current.newCount).toBe(1);
    expect(result.current.count).toBe(1);
  });

  // Review B2: messages read LIVE, then switch away and back. Even if the
  // cached watermark lags behind (another device, a missed echo), a parent
  // with nothing unread must open with NO divider — the loaded tail is the
  // baseline; only messages arriving after it can be "new".
  it('opens a caught-up parent with no divider even when the cached watermark lags', async () => {
    const { result, rerender, base } = setup(
      { pages: pagesOf(m('01A'), m('01B'), m('01C'), m('01D')) },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 0 }] },
    );
    expect(result.current.dividerMsgId).toBeUndefined();
    expect(result.current.count).toBe(0);
    expect(result.current.newCount).toBe(0);
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    // A message arriving later while scrolled up is still new.
    act(() => setListAtBottom('ch-1', false));
    rerender({ ...base, pages: pagesOf(m('01A'), m('01B'), m('01C'), m('01D'), m('01E')) });
    expect(result.current.dividerMsgId).toBe('01E');
  });

  it('does not resolve the divider before the messages have loaded', () => {
    const { result, rerender, base } = setup(
      { pages: undefined, messagesLoaded: false },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 0 }] },
    );
    expect(result.current.dividerMsgId).toBeUndefined();
    rerender({ ...base, pages: pagesOf(m('01A'), m('01B')), messagesLoaded: true });
    expect(result.current.dividerMsgId).toBeUndefined();
  });

  it('retries a read whose PUT failed (only a confirmed read dedups)', async () => {
    vi.mocked(apiFetch).mockImplementation((path: string) =>
      path.endsWith('/read') ? (Promise.reject(new Error('down')) as never) : Promise.resolve((LISTS[path] ?? undefined) as never),
    );
    const { result } = setup(
      { pages: pagesOf(m('01A')) },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 0 }] },
    );
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    act(() => result.current.markRead());
    await waitFor(() => expect(readCalls()).toHaveLength(2));
  });

  // Review N2: on a deep-link open the list publishes "not at bottom" in the
  // same commit the messages load — the open-time read must honour it.
  it('does not read on open when the list just reported not-at-bottom', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['userChannels'], [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 1 }]);
    function Harness() {
      const unread = useUnreadMarker({
        kind: 'channel', parentID: 'ch-1', pages: pagesOf(m('01A'), m('01B')),
        messagesLoaded: true, hasOlderPages: false, hasNewerPages: false, currentUserId: 'me',
      });
      return <Child count={unread.count} />;
    }
    // A child effect runs before the parent's: like MessageList on an anchor.
    function Child({ count }: { count: number }) {
      useEffect(() => setListAtBottom('ch-1', false), []);
      return <span>{count}</span>;
    }
    render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>);
    await new Promise((r) => setTimeout(r, 20));
    expect(readCalls()).toHaveLength(0);
  });

  it('reads everything (no anchor) inside a deep-link window', async () => {
    setup(
      { pages: pagesOf(m('01A')), hasNewerPages: true },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 0 }] },
    );
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    expect(readCalls()[0][1]).toEqual({ method: 'PUT' });
  });

  it('re-reads on window return only while at the bottom and focused', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { rerender, base } = setup(
      { pages: pagesOf(m('01A')) },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 0 }] },
    );
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    // A newer message loaded while away → the return reads up to it.
    rerender({ ...base, pages: pagesOf(m('01A'), m('01B')) });
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(readCalls()).toHaveLength(2));
    expect(readCalls()[1][1]).toEqual({ method: 'PUT', body: JSON.stringify({ upToMessageID: '01B' }) });

    // Scrolled up: the return leaves it unread.
    rerender({ ...base, pages: pagesOf(m('01A'), m('01B'), m('01C')) });
    act(() => setListAtBottom('ch-1', false));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Unfocused / hidden returns are ignored outright.
    hasFocus.mockReturnValue(false);
    act(() => setListAtBottom('ch-1', true));
    await waitFor(() => expect(readCalls()).toHaveLength(3)); // the at-bottom flip itself reads
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    visibility.mockRestore();
    expect(readCalls()).toHaveLength(3);
  });

  it('markRead persists regardless of scroll, and skips a PUT the read point already covers', async () => {
    setListAtBottom('ch-1', false);
    const { result } = setup(
      { pages: pagesOf(m('01A')) },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 0 }] },
    );
    act(() => result.current.markRead());
    await waitFor(() => expect(readCalls()).toHaveLength(1));
    act(() => result.current.markRead());
    expect(readCalls()).toHaveLength(1);
  });

  it('works for conversations', async () => {
    const { result } = setup(
      { kind: 'conversation', parentID: 'c-1', pages: pagesOf(m('01A', { parentID: 'c-1' }), m('01B', { parentID: 'c-1' })) },
      { conversations: [{ conversationID: 'c-1', lastReadMsgID: '01A', unreadCount: 1 }] },
    );
    expect(result.current.dividerMsgId).toBe('01B');
    await waitFor(() => expect(readCalls('/api/v1/conversations/c-1/read')).toHaveLength(1));
  });

  it('snapshots an unlisted parent as caught up once the list settles', async () => {
    const { result } = setup({ pages: pagesOf(m('01A')) }, { channels: [] });
    expect(result.current.dividerMsgId).toBeUndefined();
    expect(result.current.pending).toBe(false);
    expect(result.current.count).toBe(0);
    await waitFor(() => expect(readCalls()).toHaveLength(1));
  });

  it('waits for the list before snapshotting, and does nothing without a parent', async () => {
    let resolveList: (v: unknown) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation((path: string) =>
      path === '/api/v1/channels' ? (new Promise((r) => { resolveList = r; }) as never) : Promise.resolve(undefined as never),
    );
    const { result, rerender, base } = setup({ pages: pagesOf(m('01A'), m('01B')) });
    expect(readCalls()).toHaveLength(0);
    await act(async () => resolveList([{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 1 }]));
    await waitFor(() => expect(result.current.dividerMsgId).toBe('01B'));
    rerender({ ...base, parentID: undefined });
    expect(result.current.dividerMsgId).toBeUndefined();
    act(() => result.current.markRead());
  });

  it('forgets the local read point when the view closes', async () => {
    const { unmount } = setup(
      { pages: pagesOf(m('01A')) },
      { channels: [{ channelID: 'ch-1', lastReadMsgID: '01A', unreadCount: 0 }] },
    );
    await waitFor(() => expect(getReadThrough('ch-1')).toBe('01A'));
    unmount();
    expect(getReadThrough('ch-1')).toBeUndefined();
  });
});
