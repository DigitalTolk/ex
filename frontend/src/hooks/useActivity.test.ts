import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  useActivity,
  useReminders,
  useCreateReminder,
  useCancelReminder,
  useMarkActivityRead,
} from './useActivity';
import { queryKeys } from '@/lib/query-keys';
import type { ActivityFeed } from '@/types';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useActivity hooks', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('useActivity returns the feed', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ items: [{ id: 'a' }], unread: 2 });
    const { result } = renderHook(() => useActivity(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unread).toBe(2);
    expect(result.current.data?.items).toHaveLength(1);
  });

  it('useActivity coerces a malformed response to an empty feed', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ nope: true });
    const { result } = renderHook(() => useActivity(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ items: [], unread: 0 });
  });

  it('useActivity defaults a missing unread count to 0', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useActivity(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unread).toBe(0);
  });

  it('useReminders coerces a non-array to []', async () => {
    vi.mocked(apiFetch).mockResolvedValue(null);
    const { result } = renderHook(() => useReminders(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('useReminders returns the array', async () => {
    vi.mocked(apiFetch).mockResolvedValue([{ id: 'r1' }]);
    const { result } = renderHook(() => useReminders(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('useCreateReminder POSTs and invalidates reminders', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ id: 'r1' });
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateReminder(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync({ messageID: 'm1', parentID: 'ch1', parentType: 'channel', remindAt: '2026-06-30T12:00:00Z' });
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/reminders', expect.objectContaining({ method: 'POST' }));
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.reminders() });
  });

  it('useCancelReminder DELETEs and invalidates reminders', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const client = makeClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCancelReminder(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync('r1');
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/reminders/r1', { method: 'DELETE' });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.reminders() });
  });

  it('useMarkActivityRead zeroes the unread count in cache', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const client = makeClient();
    client.setQueryData<ActivityFeed>(queryKeys.activity(), { items: [{ id: 'a' } as never], unread: 5 });
    const { result } = renderHook(() => useMarkActivityRead(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync();
    expect(client.getQueryData<ActivityFeed>(queryKeys.activity())?.unread).toBe(0);
  });

  it('useMarkActivityRead is a no-op on an empty cache', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const client = makeClient();
    const { result } = renderHook(() => useMarkActivityRead(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync();
    expect(client.getQueryData(queryKeys.activity())).toBeUndefined();
  });
});
