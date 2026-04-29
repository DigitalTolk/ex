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
