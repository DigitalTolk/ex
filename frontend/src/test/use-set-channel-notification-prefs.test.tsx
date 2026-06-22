import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSetChannelNotificationPrefs } from '@/hooks/useChannels';

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return { qc, Wrapper };
}

describe('useSetChannelNotificationPrefs', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it('PUTs the override to the notification-preferences endpoint', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSetChannelNotificationPrefs(), { wrapper: Wrapper });
    result.current.mutate({ channelId: 'ch-1', override: { desktopLevel: 'all', threadReplies: false } });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/channels/ch-1/notification-preferences',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ desktopLevel: 'all', threadReplies: false }),
      }),
    );
  });

  it('invalidates userChannels on success', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetChannelNotificationPrefs(), { wrapper: Wrapper });
    result.current.mutate({ channelId: 'ch-1', override: {} });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith({ queryKey: ['userChannels'] });
  });
});
