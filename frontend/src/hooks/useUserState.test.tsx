import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useMarkThreadSeen, useUserState } from './useUserState';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useUserState', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('normalizes missing arrays and maps from the API', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ channelNotifications: ['ch-1'] });
    const { result } = renderHook(() => useUserState(), { wrapper });

    await waitFor(() => expect(result.current.data?.channelNotifications).toEqual(['ch-1']));
    expect(result.current.data?.threadNotifications).toEqual([]);
    expect(result.current.data?.threadSeen).toEqual({});
    expect(result.current.data?.hiddenConversations).toEqual([]);
  });

  it('marks channel and conversation threads seen', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const { result } = renderHook(() => useMarkThreadSeen(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        parentID: 'ch 1',
        parentType: 'channel',
        threadRootID: 'root/1',
        seenAt: '2026-05-04T10:00:00.000Z',
      });
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/v1/user-state/threads/channels/ch%201/root%2F1/seen',
      { method: 'PUT', body: JSON.stringify({ seenAt: '2026-05-04T10:00:00.000Z' }) },
    );

    await act(async () => {
      await result.current.mutateAsync({
        parentID: 'conv-1',
        parentType: 'conversation',
        threadRootID: 'root-2',
      });
    });
    expect(vi.mocked(apiFetch).mock.calls[1][0]).toBe(
      '/api/v1/user-state/threads/conversations/conv-1/root-2/seen',
    );
  });
});
