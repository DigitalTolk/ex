import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useChannelMessages } from './useMessages';

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

  it('re-mount after fetchPreviousPage refetches the around-page too (regression: v5 stale-refetch on mount only walks pages[0]→getNextPageParam; pages[0] is the newer-window after a fetchPreviousPage, so the older around-window never re-runs and the cache decays toward the newer-page-only state the user hit on the /search → DM hop)', async () => {
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
