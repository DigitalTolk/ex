import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useConversation,
  useCreateConversation,
  useUserLookup,
} from './useConversations';

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

describe('useConversation', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('fetches a conversation by id', async () => {
    const conv = { id: 'conv-1', type: 'dm', participantIDs: ['u-1', 'u-2'], createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(conv);

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations/conv-1');
  });

  it('is disabled when id is undefined', () => {
    const { result } = renderHook(() => useConversation(undefined), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});

describe('useCreateConversation', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('calls correct endpoint', async () => {
    const conv = { id: 'conv-new', type: 'dm', participantIDs: ['u-1'], createdAt: '' };
    vi.mocked(apiFetch).mockResolvedValue(conv);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });
    result.current.mutate({ type: 'dm', participantIDs: ['u-1'] });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({ type: 'dm', participantIDs: ['u-1'] }),
    });
  });
});

describe('useUserLookup', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('searches when query length >= 2', async () => {
    const users = [{ id: 'u-1', displayName: 'Alice', email: 'a@a.com' }];
    vi.mocked(apiFetch).mockResolvedValue(users);

    const { result } = renderHook(() => useUserLookup('al'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // With the query's abort signal, so a superseded search is cancelled.
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/users?q=al', { signal: expect.any(AbortSignal) });
  });

  it('keeps the previous results while the next term loads, when asked to', async () => {
    let resolveNext: (v: unknown) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/v1/users?q=ali') return new Promise((resolve) => { resolveNext = resolve; });
      return path === '/api/v1/users?q=al' ? [{ id: 'u-1', displayName: 'Alice', email: 'a@a.com' }] : [];
    });
    const { result, rerender } = renderHook(({ q }) => useUserLookup(q, { keepPrevious: true }), {
      wrapper: createWrapper(),
      initialProps: { q: 'al' },
    });
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    rerender({ q: 'ali' });
    expect(result.current.data?.[0].id).toBe('u-1');
    expect(result.current.isPlaceholderData).toBe(true);
    await act(async () => {
      resolveNext([]);
    });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it('is disabled when query is too short', () => {
    const { result } = renderHook(() => useUserLookup('a'), { wrapper: createWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
  });
});
