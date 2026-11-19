import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useChannel,
  useChannelBySlug,
  useChannelMembers,
  useBrowseChannels,
  useJoinChannel,
  useSetChannelIcon,
} from './useChannels';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe('useChannel', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('fetches a single channel by id', async () => {
    const channel = { id: 'ch-1', name: 'general', slug: 'general', type: 'public', createdBy: 'u-1', archived: false, createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(channel);

    const { result } = renderHook(() => useChannel('ch-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1');
    expect(result.current.data).toEqual(channel);
  });

  it('is disabled when channelId is undefined', () => {
    const { result } = renderHook(() => useChannel(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useChannelBySlug', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('fetches channel by slug', async () => {
    const channel = { id: 'ch-1', name: 'general', slug: 'general', type: 'public', createdBy: 'u-1', archived: false, createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(channel);

    const { result } = renderHook(() => useChannelBySlug('general'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/general');
  });

  it('is disabled when slug is undefined', () => {
    const { result } = renderHook(() => useChannelBySlug(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useChannelMembers', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('fetches members for a channel', async () => {
    const members = [{ channelID: 'ch-1', userID: 'u-1', role: 'owner', displayName: 'Alice', joinedAt: '' }];
    vi.mocked(apiFetch).mockResolvedValue(members);

    const { result } = renderHook(() => useChannelMembers('ch-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/members');
  });

  it('is disabled when channelId is undefined', () => {
    const { result } = renderHook(() => useChannelMembers(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useBrowseChannels', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('fetches browseable channels', async () => {
    const channels = [{ id: 'ch-1', name: 'general', slug: 'general', type: 'public', createdBy: 'u-1', archived: false, createdAt: '' }];
    vi.mocked(apiFetch).mockResolvedValue(channels);

    const { result } = renderHook(() => useBrowseChannels(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/browse');
  });
});

describe('useJoinChannel', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('calls join endpoint', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);

    const { result } = renderHook(() => useJoinChannel(), { wrapper: createWrapper() });
    result.current.mutate('ch-1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/join', { method: 'POST' });
  });
});

describe('useSetChannelIcon', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(showToast).mockReset();
  });

  function setup() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children);
    return { invalidateSpy, ...renderHook(() => useSetChannelIcon(), { wrapper }) };
  }

  it('PUTs the emoji name, then refetches the open channel and the channel list', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: 'ch-1', icon: 'rocket' });
    const { result, invalidateSpy } = setup();

    act(() => result.current.run({ channelId: 'ch-1', icon: 'rocket' }));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['userChannels'] }));

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/icon', {
      method: 'PUT',
      body: JSON.stringify({ icon: 'rocket' }),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channelBySlug'] });
    expect(showToast).not.toHaveBeenCalled();
  });

  it('takes the icon away with an empty name', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: 'ch-1' });
    const { result, invalidateSpy } = setup();

    act(() => result.current.run({ channelId: 'ch-1', icon: '' }));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['channelBySlug'] }));

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/channels/ch-1/icon', {
      method: 'PUT',
      body: JSON.stringify({ icon: '' }),
    });
  });

  it('says so when the server refuses, and refetches nothing', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('forbidden'));
    const { result, invalidateSpy } = setup();

    act(() => result.current.run({ channelId: 'ch-1', icon: 'rocket' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Couldn't change the icon. Try again."));
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('sends one request for a pick repeated while the first is still out', async () => {
    let finish!: (value: unknown) => void;
    vi.mocked(apiFetch).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { result, invalidateSpy } = setup();

    act(() => result.current.run({ channelId: 'ch-1', icon: 'rocket' }));
    await waitFor(() => expect(result.current.isPending).toBe(true));
    act(() => result.current.run({ channelId: 'ch-1', icon: 'rocket' }));
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => finish({ id: 'ch-1', icon: 'rocket' }));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['userChannels'] }));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
