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
});
