import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useUserChannels, useCreateChannel } from './useChannels';

// Mock the api module
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

describe('useUserChannels', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('calls the correct endpoint', async () => {
    const channels = [
      {
        channelID: 'ch-1',
        channelName: 'general',
        channelType: 'public',
        role: 2,
      },
    ];
    vi.mocked(apiFetch).mockResolvedValue(channels);

    const { result } = renderHook(() => useUserChannels(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels');
    expect(result.current.data).toEqual(channels);
  });
});

describe('useCreateChannel', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('invalidates queries on success', async () => {
    const created = {
      id: 'ch-new',
      name: 'new-channel',
      type: 'public',
      createdBy: 'u-1',
      archived: false,
      createdAt: '2025-01-01T00:00:00Z',
    };
    vi.mocked(apiFetch).mockResolvedValue(created);

    const wrapper = createWrapper();
    const { result } = renderHook(() => useCreateChannel(), { wrapper });

    result.current.mutate({
      name: 'new-channel',
      type: 'public',
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Verify it called apiFetch with the correct endpoint and method
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'new-channel', type: 'public' }),
    });
  });
});
