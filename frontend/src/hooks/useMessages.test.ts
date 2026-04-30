import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useChannelMessages,
  appendMessageToCache,
  updateMessageInCache,
  removeMessageFromCache,
  bumpThreadReplyMetadata,
  resyncMessageCache,
  useEditMessage,
  useDeleteMessage,
  useToggleReaction,
  useSetPinned,
  useSetNoUnfurl,
  type MessageWindow,
  type MessagePageParam,
} from './useMessages';
import type { Message } from '@/types';
import type { InfiniteData } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

describe('useChannelMessages', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('calls correct endpoint with pagination params', async () => {
    const page = {
      items: [
        {
          id: 'msg-1',
          parentID: 'ch-1',
          authorID: 'u-1',
          body: 'hello',
          createdAt: '2025-01-01T00:00:00Z',
        },
      ],
      hasMore: false,
    };
    vi.mocked(apiFetch).mockResolvedValue(page);

    const { result } = renderHook(() => useChannelMessages('ch-1'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The hook builds a URL with limit=50
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/channels/ch-1/messages'),
    );
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('limit=50'),
    );
  });

  it('is disabled when channelId is undefined', () => {
    const { result } = renderHook(() => useChannelMessages(undefined), {
      wrapper: createWrapper(),
    });

    // Should not fetch at all
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('seeds the initial fetch with /around when an anchor is provided', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      items: [],
      hasMore: false,
      hasMoreOlder: true,
      hasMoreNewer: true,
    });
    const { result } = renderHook(() => useChannelMessages('ch-1', 'msg-deep'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const url = String(vi.mocked(apiFetch).mock.calls[0][0]);
    expect(url).toContain('around=msg-deep');
    expect(url).toContain('before=25');
    expect(url).toContain('after_count=25');
  });

  it('passes ?cursor= when fetching the next (older) page', async () => {
    let call = 0;
    vi.mocked(apiFetch).mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          items: [{ id: 'msg-tail', parentID: 'ch-1', authorID: 'u-1', body: 'x', createdAt: '2025-01-01T00:00:00Z' }],
          hasMoreOlder: true,
          hasMoreNewer: false,
          oldestID: 'msg-tail',
        });
      }
      return Promise.resolve({ items: [], hasMoreOlder: false, hasMoreNewer: false });
    });
    const { result } = renderHook(() => useChannelMessages('ch-1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    result.current.fetchNextPage();
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBe(2));
    const url = String(vi.mocked(apiFetch).mock.calls[1][0]);
    expect(url).toContain('cursor=msg-tail');
  });

  it('passes ?after= when fetching the previous (newer) page', async () => {
    let call = 0;
    vi.mocked(apiFetch).mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          items: [{ id: 'msg-anchor', parentID: 'ch-1', authorID: 'u-1', body: 'x', createdAt: '2025-01-01T00:00:00Z' }],
          hasMoreOlder: false,
          hasMoreNewer: true,
          newestID: 'msg-anchor',
        });
      }
      return Promise.resolve({ items: [], hasMoreOlder: false, hasMoreNewer: false });
    });
    const { result } = renderHook(() => useChannelMessages('ch-1', 'msg-anchor'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    result.current.fetchPreviousPage();
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBe(2));
    const url = String(vi.mocked(apiFetch).mock.calls[1][0]);
    expect(url).toContain('after=msg-anchor');
  });

  it('re-mount with a deep-link anchor re-fires ?around= even after a prior fetchPreviousPage (v5 stale-refetch regression)', async () => {
    // Mirrors the user-reported flow:
    //   1. /conversation/X#msg-Y hard-refresh fires ?around=Y → 33 items
    //   2. user scrolls, fetchPreviousPage fires ?after=newestID → 2 newer items
    //   3. user navigates to /search, then back to the same URL — the
    //      cached query is stale, triggering a refetch.
    //   4. v5 refetches starting at pages[0]; pages[0] is the newer page,
    //      and our `getNextPageParam` returns undefined for newer-pages
    //      (backend writes hasMoreOlder=false on after-windows). Refetch
    //      stops after page 1 and the older around-window is gone.
    let call = 0;
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      call++;
      if (url.includes('around=msg-anchor')) {
        return Promise.resolve({
          items: Array.from({ length: 33 }, (_, i) => ({
            id: `msg-around-${i}`, parentID: 'ch-1', authorID: 'u-1', body: `m${i}`, createdAt: '2025-01-01T00:00:00Z',
          })),
          hasMoreOlder: false,
          hasMoreNewer: true,
          oldestID: 'msg-around-0',
          newestID: 'msg-around-32',
        });
      }
      if (url.includes('after=msg-around-32')) {
        return Promise.resolve({
          items: [
            { id: 'msg-newer-1', parentID: 'ch-1', authorID: 'u-1', body: 'n1', createdAt: '2025-01-01T00:00:00Z' },
            { id: 'msg-newer-2', parentID: 'ch-1', authorID: 'u-1', body: 'n2', createdAt: '2025-01-01T00:00:00Z' },
          ],
          hasMoreOlder: false, // backend hardcodes this for after-fetches
          hasMoreNewer: false,
          oldestID: 'msg-newer-1',
          newestID: 'msg-newer-2',
        });
      }
      return Promise.resolve({ items: [], hasMoreOlder: false, hasMoreNewer: false });
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);

    const { result, unmount } = renderHook(() => useChannelMessages('ch-1', 'msg-anchor'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Sanity: initial around-fetch ran.
    expect(call).toBe(1);
    expect(result.current.data?.pages).toHaveLength(1);

    result.current.fetchPreviousPage();
    await waitFor(() => expect(result.current.data?.pages.length).toBe(2));

    // Cache shape matches the user's flow before the bug fires:
    // [newerPage(2), aroundPage(33)] — newer-direction page is pages[0].
    expect(result.current.data?.pages[0].items[0].id).toBe('msg-newer-1');
    expect(result.current.data?.pages[1].items[0].id).toBe('msg-around-0');
    expect(call).toBe(2);

    // Unmount the consumer — gcTime: 0 on anchored queries means the
    // cache is dropped synchronously on unmount, so re-mount starts
    // fresh. Without that, v5's stale-refetch walks forward from
    // pages[0] (the newer-window), stops at page 0, and serves the
    // partial state to the next consumer.
    unmount();
    // Yield to the microtask queue so react-query's GC cleanup runs.
    await new Promise((r) => setTimeout(r, 0));
    const callsBeforeRemount = call;

    const { result: result2 } = renderHook(() => useChannelMessages('ch-1', 'msg-anchor'), { wrapper });
    await waitFor(() => expect(result2.current.isSuccess).toBe(true));

    const remountUrls = vi.mocked(apiFetch).mock.calls
      .slice(callsBeforeRemount)
      .map((c) => String(c[0]));

    // The around-page MUST be among the requests fired on re-mount.
    // The v5 default behaviour is to walk forward from pages[0] via
    // getNextPageParam, which after a fetchPreviousPage starts from
    // the newer-window page — and our `getNextPageParam` returns
    // undefined for newer pages (backend writes hasMoreOlder=false on
    // after-fetches). That stops the refetch after page 0 and the
    // around-window slowly decays from cache.
    expect(remountUrls.some((u) => u.includes('around=msg-anchor'))).toBe(true);

    // After re-mount, the around-window must still be visible.
    const items = result2.current.data?.pages.flatMap((p) => p.items) ?? [];
    expect(items.find((m) => m.id === 'msg-around-0')).toBeTruthy();
  });

  it('exposes hasPreviousPage when the initial window has more newer messages', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      items: [{ id: 'msg-1', parentID: 'ch-1', authorID: 'u-1', body: 'x', createdAt: '2025-01-01T00:00:00Z' }],
      hasMoreOlder: false,
      hasMoreNewer: true,
      newestID: 'msg-1',
    });
    const { result } = renderHook(() => useChannelMessages('ch-1', 'msg-1'), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasPreviousPage).toBe(true);
    expect(result.current.hasNextPage).toBe(false);
  });
});

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm',
    parentID: 'ch-1',
    authorID: 'u',
    body: 'hi',
    createdAt: '2026-04-30T00:00:00Z',
    ...overrides,
  };
}

function seedCache(qc: QueryClient, key: unknown[], data: InfiniteData<MessageWindow, MessagePageParam>) {
  qc.setQueryData(key, data);
}

describe('cache patching helpers (avoiding v5 walk-forward refetch)', () => {
  it('appendMessageToCache prepends to pages[0] when it is the live tail', () => {
    // Regression: invalidateQueries on a deep-link infinite query
    // truncates the page chain (see appendMessageToCache jsdoc).
    // Patching directly preserves the chain.
    const qc = new QueryClient();
    const aroundPage: MessageWindow = {
      items: [makeMsg({ id: 'm-2' }), makeMsg({ id: 'm-1' })],
      hasMoreOlder: true,
      hasMoreNewer: true,
      newestID: 'm-2',
      oldestID: 'm-1',
    };
    const newerPage: MessageWindow = {
      items: [makeMsg({ id: 'm-4' }), makeMsg({ id: 'm-3' })],
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: 'm-4',
      oldestID: 'm-3',
    };
    seedCache(qc, ['channelMessages', 'ch-1', 'm-1'], {
      pages: [newerPage, aroundPage],
      pageParams: [
        { kind: 'newer', after: 'm-2' },
        { kind: 'around', msgId: 'm-1', before: 25, after: 25 },
      ],
    });
    appendMessageToCache(qc, 'ch-1', makeMsg({ id: 'm-5' }));
    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', 'm-1',
    ]);
    expect(result?.pages.length).toBe(2);
    expect(result?.pages[0].items.map((m) => m.id)).toEqual(['m-5', 'm-4', 'm-3']);
    expect(result?.pages[0].newestID).toBe('m-5');
    expect(result?.pages[1]).toBe(aroundPage);
  });

  it('appendMessageToCache is a no-op when pages[0] still has more newer pages to fetch', () => {
    // The new message belongs to a future page that doesn't exist in
    // cache yet; load-newer pagination will pick it up. Don't risk
    // inserting it into the wrong page.
    const qc = new QueryClient();
    const aroundPage: MessageWindow = {
      items: [makeMsg({ id: 'm-1' })],
      hasMoreOlder: false,
      hasMoreNewer: true, // <-- not at live tail
      newestID: 'm-1',
      oldestID: 'm-1',
    };
    seedCache(qc, ['channelMessages', 'ch-1', 'm-1'], {
      pages: [aroundPage],
      pageParams: [{ kind: 'around', msgId: 'm-1', before: 25, after: 25 }],
    });
    appendMessageToCache(qc, 'ch-1', makeMsg({ id: 'm-2' }));
    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', 'm-1',
    ]);
    expect(result?.pages[0].items.map((m) => m.id)).toEqual(['m-1']);
  });

  it('appendMessageToCache dedupes WS echoes of an already-cached message', () => {
    const qc = new QueryClient();
    seedCache(qc, ['channelMessages', 'ch-1', null], {
      pages: [{
        items: [makeMsg({ id: 'm-1' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
        newestID: 'm-1',
      }],
      pageParams: [{ kind: 'tail' }],
    });
    appendMessageToCache(qc, 'ch-1', makeMsg({ id: 'm-1' }));
    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(result?.pages[0].items.length).toBe(1);
  });

  it('updateMessageInCache replaces the message in whichever page holds it', () => {
    const qc = new QueryClient();
    seedCache(qc, ['conversationMessages', 'dm-1', null], {
      pages: [
        { items: [makeMsg({ id: 'm-2', body: 'old' })], hasMoreOlder: true, hasMoreNewer: false, newestID: 'm-2' },
        { items: [makeMsg({ id: 'm-1' })], hasMoreOlder: false, hasMoreNewer: false, oldestID: 'm-1' },
      ],
      pageParams: [{ kind: 'tail' }, { kind: 'older', cursor: 'm-2' }],
    });
    updateMessageInCache(qc, 'dm-1', makeMsg({ id: 'm-2', body: 'edited' }));
    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'conversationMessages', 'dm-1', null,
    ]);
    expect(result?.pages[0].items[0].body).toBe('edited');
    expect(result?.pages.length).toBe(2);
  });

  it('removeMessageFromCache filters the message out without touching other pages', () => {
    const qc = new QueryClient();
    seedCache(qc, ['channelMessages', 'ch-1', null], {
      pages: [{
        items: [makeMsg({ id: 'm-2' }), makeMsg({ id: 'm-1' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
      }],
      pageParams: [{ kind: 'tail' }],
    });
    removeMessageFromCache(qc, 'ch-1', 'm-1');
    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(result?.pages[0].items.map((m) => m.id)).toEqual(['m-2']);
  });

  it('bumpThreadReplyMetadata increments replyCount and sets recent authors on the parent', () => {
    const qc = new QueryClient();
    seedCache(qc, ['channelMessages', 'ch-1', null], {
      pages: [{
        items: [makeMsg({ id: 'root', replyCount: 1, recentReplyAuthorIDs: ['u-a'] })],
        hasMoreOlder: false,
        hasMoreNewer: false,
      }],
      pageParams: [{ kind: 'tail' }],
    });
    bumpThreadReplyMetadata(qc, 'ch-1', makeMsg({
      id: 'reply-1',
      authorID: 'u-b',
      parentMessageID: 'root',
      createdAt: '2026-04-30T01:00:00Z',
    }));
    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    const root = result?.pages[0].items[0];
    expect(root?.replyCount).toBe(2);
    expect(root?.lastReplyAt).toBe('2026-04-30T01:00:00Z');
    expect(root?.recentReplyAuthorIDs).toEqual(['u-b', 'u-a']);
  });

  it('bumpThreadReplyMetadata is a no-op when the parent is not in cache (older page not loaded)', () => {
    const qc = new QueryClient();
    seedCache(qc, ['channelMessages', 'ch-1', null], {
      pages: [{
        items: [makeMsg({ id: 'unrelated' })],
        hasMoreOlder: true,
        hasMoreNewer: false,
      }],
      pageParams: [{ kind: 'tail' }],
    });
    expect(() =>
      bumpThreadReplyMetadata(qc, 'ch-1', makeMsg({ id: 'r', parentMessageID: 'missing-root' })),
    ).not.toThrow();
  });

});

describe('resyncMessageCache (WS reconnect catch-up)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('fetches newer messages and prepends them to tail-mode pages[0]', async () => {
    const qc = new QueryClient();
    const head: MessageWindow = {
      items: [makeMsg({ id: 'm-2' }), makeMsg({ id: 'm-1' })],
      hasMoreOlder: false,
      hasMoreNewer: false, // <-- live tail
      newestID: 'm-2',
      oldestID: 'm-1',
    };
    qc.setQueryData(['channelMessages', 'ch-1', null], {
      pages: [head],
      pageParams: [{ kind: 'tail' }],
    });
    vi.mocked(apiFetch).mockResolvedValueOnce({
      items: [makeMsg({ id: 'm-3' })],
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: 'm-3',
      oldestID: 'm-3',
    });

    await resyncMessageCache(qc);

    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(result?.pages[0].items.map((m) => m.id)).toEqual(['m-3', 'm-2', 'm-1']);
    expect(result?.pages[0].newestID).toBe('m-3');
    expect(vi.mocked(apiFetch).mock.calls[0][0]).toMatch(/\/messages\?after=m-2&limit=50/);
  });

  it('skips deep-link queries (head.hasMoreNewer === true)', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['channelMessages', 'ch-1', 'msg-anchor'], {
      pages: [{
        items: [makeMsg({ id: 'm-1' })],
        hasMoreOlder: true,
        hasMoreNewer: true, // <-- not at live tail
        newestID: 'm-1',
      }],
      pageParams: [{ kind: 'around', msgId: 'msg-anchor', before: 25, after: 25 }],
    });

    await resyncMessageCache(qc);

    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('dedupes a returned message that is already in pages[0] (WS event won the race)', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['channelMessages', 'ch-1', null], {
      pages: [{
        items: [makeMsg({ id: 'm-2' }), makeMsg({ id: 'm-1' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
        newestID: 'm-2',
      }],
      pageParams: [{ kind: 'tail' }],
    });
    vi.mocked(apiFetch).mockResolvedValueOnce({
      items: [makeMsg({ id: 'm-2' })], // already cached
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: 'm-2',
    });

    await resyncMessageCache(qc);

    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(result?.pages[0].items.map((m) => m.id)).toEqual(['m-2', 'm-1']);
  });

  it('swallows fetch errors so a transient failure does not crash on reconnect', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['channelMessages', 'ch-1', null], {
      pages: [{
        items: [makeMsg({ id: 'm-1' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
        newestID: 'm-1',
      }],
      pageParams: [{ kind: 'tail' }],
    });
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('network'));

    await expect(resyncMessageCache(qc)).resolves.toBeUndefined();
  });

  it('useSetPinned patches the cached message with the server response', async () => {
    const qc = new QueryClient();
    const wrap = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    qc.setQueryData(['channelMessages', 'ch-1', null], {
      pages: [{
        items: [makeMsg({ id: 'm-1', body: 'x' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
      }],
      pageParams: [{ kind: 'tail' }],
    });
    vi.mocked(apiFetch).mockResolvedValueOnce(makeMsg({ id: 'm-1', body: 'x', pinned: true } as Partial<Message>));

    const { result } = renderHook(() => useSetPinned(), { wrapper: wrap });
    result.current.mutate({ channelId: 'ch-1', messageId: 'm-1', pinned: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const out = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(out?.pages[0].items[0].pinned).toBe(true);
  });

  it('useEditMessage / useDeleteMessage / useToggleReaction / useSetNoUnfurl all patch the message-list cache', async () => {
    const qc = new QueryClient();
    const wrap = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    qc.setQueryData(['channelMessages', 'ch-1', null], {
      pages: [{
        items: [makeMsg({ id: 'm-1', body: 'old' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
      }],
      pageParams: [{ kind: 'tail' }],
    });

    // Edit
    vi.mocked(apiFetch).mockResolvedValueOnce(makeMsg({ id: 'm-1', body: 'edited' }));
    const edit = renderHook(() => useEditMessage(), { wrapper: wrap });
    edit.result.current.mutate({ channelId: 'ch-1', messageId: 'm-1', body: 'edited' });
    await waitFor(() => expect(edit.result.current.isSuccess).toBe(true));
    let out = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(out?.pages[0].items[0].body).toBe('edited');

    // ToggleReaction (returns updated message)
    vi.mocked(apiFetch).mockResolvedValueOnce(
      makeMsg({ id: 'm-1', body: 'edited', reactions: { '👍': ['u-1'] } } as Partial<Message>),
    );
    const react = renderHook(() => useToggleReaction(), { wrapper: wrap });
    react.result.current.mutate({ channelId: 'ch-1', messageId: 'm-1', emoji: '👍' });
    await waitFor(() => expect(react.result.current.isSuccess).toBe(true));
    out = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(out?.pages[0].items[0].reactions).toEqual({ '👍': ['u-1'] });

    // SetNoUnfurl
    vi.mocked(apiFetch).mockResolvedValueOnce(makeMsg({ id: 'm-1', noUnfurl: true } as Partial<Message>));
    const noUnfurl = renderHook(() => useSetNoUnfurl(), { wrapper: wrap });
    noUnfurl.result.current.mutate({ channelId: 'ch-1', messageId: 'm-1', noUnfurl: true });
    await waitFor(() => expect(noUnfurl.result.current.isSuccess).toBe(true));
    out = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(out?.pages[0].items[0].noUnfurl).toBe(true);

    // Delete
    vi.mocked(apiFetch).mockResolvedValueOnce(undefined);
    const del = renderHook(() => useDeleteMessage(), { wrapper: wrap });
    del.result.current.mutate({ channelId: 'ch-1', messageId: 'm-1' });
    await waitFor(() => expect(del.result.current.isSuccess).toBe(true));
    out = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'channelMessages', 'ch-1', null,
    ]);
    expect(out?.pages[0].items).toEqual([]);
  });

  it('catches up conversations the same way as channels', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['conversationMessages', 'dm-1', null], {
      pages: [{
        items: [makeMsg({ id: 'd-1', parentID: 'dm-1' })],
        hasMoreOlder: false,
        hasMoreNewer: false,
        newestID: 'd-1',
      }],
      pageParams: [{ kind: 'tail' }],
    });
    vi.mocked(apiFetch).mockResolvedValueOnce({
      items: [makeMsg({ id: 'd-2', parentID: 'dm-1' })],
      hasMoreOlder: false,
      hasMoreNewer: false,
      newestID: 'd-2',
    });

    await resyncMessageCache(qc);

    expect(vi.mocked(apiFetch).mock.calls[0][0]).toMatch(/\/conversations\/dm-1\/messages/);
    const result = qc.getQueryData<InfiniteData<MessageWindow, MessagePageParam>>([
      'conversationMessages', 'dm-1', null,
    ]);
    expect(result?.pages[0].items.map((m) => m.id)).toEqual(['d-2', 'd-1']);
  });
});
