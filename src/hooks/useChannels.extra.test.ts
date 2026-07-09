import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useChannel,
  useChannelBySlug,
  useChannelMembers,
  useBrowseChannels,
  useJoinChannel,
} from './useChannels';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';

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
