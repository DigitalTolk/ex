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
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
import { apiFetch } from '@/lib/api';
import { showToast } from '@/lib/toast';

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useActivity hooks', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(showToast).mockClear();
  });

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
    expect(showToast).toHaveBeenCalledWith('Reminder set', 'success');
  });

  it('useCreateReminder toasts an error when the POST fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useCreateReminder(), { wrapper: wrapperFor(makeClient()) });
    await expect(
      result.current.mutateAsync({ messageID: 'm1', parentID: 'ch1', parentType: 'channel', remindAt: '2026-06-30T12:00:00Z' }),
    ).rejects.toThrow();
    expect(showToast).toHaveBeenCalledWith("Couldn't set the reminder — please try again.");
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

  it('useMarkActivityRead cancels the in-flight activity fetch and reconciles so a stale read cannot clobber the zero', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const client = makeClient();
    const cancelSpy = vi.spyOn(client, 'cancelQueries');
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    client.setQueryData<ActivityFeed>(queryKeys.activity(), { items: [{ id: 'a' } as never], unread: 3 });
    const { result } = renderHook(() => useMarkActivityRead(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync();
    // In-flight GET is aborted before the optimistic zero so it can't overwrite it.
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
    // Then a reconciling refetch against the now-advanced server watermark.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
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
