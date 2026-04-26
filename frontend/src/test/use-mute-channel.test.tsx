import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMuteChannel } from '@/hooks/useChannels';

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

describe('useMuteChannel', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it('PUTs muted=true to the channel mute endpoint', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useMuteChannel(), { wrapper: Wrapper });
    result.current.mutate({ channelId: 'ch-1', muted: true });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/v1/channels/ch-1/mute',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ muted: true }),
      }),
    );
  });

  it('PUTs muted=false to unmute', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useMuteChannel(), { wrapper: Wrapper });
    result.current.mutate({ channelId: 'ch-2', muted: false });
    await waitFor(() => expect(mockApiFetch).toHaveBeenCalled());
    expect(mockApiFetch.mock.calls[0][1].body).toBe(JSON.stringify({ muted: false }));
  });

  it('invalidates userChannels on success', async () => {
    mockApiFetch.mockResolvedValue(undefined);
    const { qc, Wrapper } = wrap();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useMuteChannel(), { wrapper: Wrapper });
    result.current.mutate({ channelId: 'ch-1', muted: true });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith({ queryKey: ['userChannels'] });
  });
});
