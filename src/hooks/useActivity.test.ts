import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  applyActivityChangedEvent,
  applyActivityNewEvent,
  useActivity,
  useReminders,
  useCreateReminder,
  useCancelReminder,
  useMarkActivityRead,
  useActivityUnread,
  useRemoveActivityItems,
  useSetActivityItemsRead,
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
    vi.mocked(apiFetch).mockResolvedValue({ items: [{ id: 'a' }], unread: 2, unreadByType: { mention: 2 } });
    const { result } = renderHook(() => useActivity(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unread).toBe(2);
    expect(result.current.data?.unreadByType).toEqual({ mention: 2 });
    expect(result.current.data?.items).toHaveLength(1);
  });

  it('useActivity coerces a malformed response to an empty feed', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ nope: true });
    const { result } = renderHook(() => useActivity(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toEqual({ items: [], unread: 0, unreadByType: {} });
  });

  it('useActivity defaults a missing unread count to 0', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useActivity(), { wrapper: wrapperFor(makeClient()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.unread).toBe(0);
    expect(result.current.data?.unreadByType).toEqual({});
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
    client.setQueryData<ActivityFeed>(queryKeys.activity(), {
      items: [{ id: 'a', read: false } as never],
      unread: 5,
      unreadByType: { mention: 5 },
    });
    const { result } = renderHook(() => useMarkActivityRead(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync();
    const feed = client.getQueryData<ActivityFeed>(queryKeys.activity());
    expect(feed?.unread).toBe(0);
    expect(feed?.unreadByType).toEqual({});
    expect(feed?.items[0].read).toBe(true);
  });

  // The server answers every activity write with an activity.read event that
  // every tab applies, so a successful write refetches nothing.
  it('useMarkActivityRead cancels the in-flight activity fetch and does not refetch after succeeding', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const client = makeClient();
    const cancelSpy = vi.spyOn(client, 'cancelQueries');
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    client.setQueryData<ActivityFeed>(queryKeys.activity(), { items: [{ id: 'a' } as never], unread: 3, unreadByType: {} });
    const { result } = renderHook(() => useMarkActivityRead(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync();
    // In-flight GET is aborted before the optimistic zero so it can't overwrite it.
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(client.getQueryData<ActivityFeed>(queryKeys.activity())?.unread).toBe(0);
  });

  it('useMarkActivityRead is a no-op on an empty cache', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const client = makeClient();
    const { result } = renderHook(() => useMarkActivityRead(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync();
    expect(client.getQueryData(queryKeys.activity())).toBeUndefined();
  });

  // A failed write must not leave its optimistic patch behind: it refetches
  // the server's truth, and says so.
  it('useMarkActivityRead undoes its patch and toasts when the write fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('500'));
    const client = makeClient();
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
    const { result } = renderHook(() => useMarkActivityRead(), { wrapper: wrapperFor(client) });
    await expect(result.current.mutateAsync()).rejects.toThrow();
    expect(showToast).toHaveBeenCalledWith("Couldn't update activity — please try again.");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: queryKeys.activity() });
  });

  it('useSetActivityItemsRead PUTs the ids and patches the cache optimistically', async () => {
    let resolve: () => void = () => {};
    vi.mocked(apiFetch).mockImplementation(() => new Promise<void>((r) => (resolve = r)) as never);
    const client = makeClient();
    client.setQueryData<ActivityFeed>(queryKeys.activity(), {
      items: [{ id: 'a', type: 'mention', read: false } as never, { id: 'b', type: 'dm', read: false } as never],
      unread: 2,
      unreadByType: { mention: 1, dm: 1 },
    });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSetActivityItemsRead(), { wrapper: wrapperFor(client) });
    result.current.mutate({ ids: ['a'], read: true });
    await waitFor(() => expect(client.getQueryData<ActivityFeed>(queryKeys.activity())?.unread).toBe(1));
    expect(client.getQueryData<ActivityFeed>(queryKeys.activity())?.unreadByType).toEqual({ dm: 1 });
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/activity/items/read', {
      method: 'PUT',
      body: JSON.stringify({ ids: ['a'], read: true }),
    });
    resolve();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('useSetActivityItemsRead toasts on failure and leaves an empty cache alone', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('500'));
    const client = makeClient();
    const { result } = renderHook(() => useSetActivityItemsRead(), { wrapper: wrapperFor(client) });
    await expect(result.current.mutateAsync({ ids: ['a'], read: false })).rejects.toThrow();
    expect(showToast).toHaveBeenCalledWith("Couldn't update activity — please try again.");
    expect(client.getQueryData(queryKeys.activity())).toBeUndefined();
  });

  it('useRemoveActivityItems POSTs the ids and drops them from the cache', async () => {
    vi.mocked(apiFetch).mockResolvedValue(undefined);
    const client = makeClient();
    client.setQueryData<ActivityFeed>(queryKeys.activity(), {
      items: [{ id: 'a', type: 'mention', read: false } as never, { id: 'b', type: 'dm', read: true } as never],
      unread: 1,
      unreadByType: { mention: 1 },
    });
    const { result } = renderHook(() => useRemoveActivityItems(), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync(['a']);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/activity/items/remove', {
      method: 'POST',
      body: JSON.stringify({ ids: ['a'] }),
    });
    const feed = client.getQueryData<ActivityFeed>(queryKeys.activity());
    expect(feed?.items.map((i) => i.id)).toEqual(['b']);
    expect(feed?.unread).toBe(0);
  });

  it('useRemoveActivityItems toasts when the write fails', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useRemoveActivityItems(), { wrapper: wrapperFor(makeClient()) });
    await expect(result.current.mutateAsync(['a'])).rejects.toThrow();
    expect(showToast).toHaveBeenCalledWith("Couldn't update activity — please try again.");
  });
});

describe('activity events', () => {
  const seeded = (): ActivityFeed => ({
    items: [{ id: 'a', type: 'mention', read: false } as never],
    unread: 1,
    unreadByType: { mention: 1 },
  });

  it('activity.new adds the carried item to the cached feed without refetching', () => {
    const client = makeClient();
    client.setQueryData(queryKeys.activity(), seeded());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyActivityNewEvent(client, { item: { id: 'b', type: 'dm', read: false } });
    const feed = client.getQueryData<ActivityFeed>(queryKeys.activity());
    expect(feed?.items.map((i) => i.id)).toEqual(['b', 'a']);
    expect(feed?.unread).toBe(2);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('activity.new refetches when there is no item, no cache, or a fetch in flight', () => {
    const client = makeClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyActivityNewEvent(client, { item: { id: 'b', type: 'dm' } });
    expect(invalidate).toHaveBeenCalledTimes(1);

    client.setQueryData(queryKeys.activity(), seeded());
    applyActivityNewEvent(client, {});
    expect(invalidate).toHaveBeenCalledTimes(2);

    vi.spyOn(client, 'isFetching').mockReturnValue(1);
    applyActivityNewEvent(client, { item: { id: 'b', type: 'dm' } });
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(client.getQueryData<ActivityFeed>(queryKeys.activity())?.items).toHaveLength(1);
  });

  it('activity.read applies marks and removals, and refetches for parent reads', () => {
    const client = makeClient();
    client.setQueryData(queryKeys.activity(), seeded());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyActivityChangedEvent(client, { ids: ['a'], read: true });
    expect(client.getQueryData<ActivityFeed>(queryKeys.activity())?.unread).toBe(0);
    applyActivityChangedEvent(client, { removed: ['a'] });
    expect(client.getQueryData<ActivityFeed>(queryKeys.activity())?.items).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    applyActivityChangedEvent(client, { parentID: 'dm-1' });
    applyActivityChangedEvent(client, null);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  // Reminders gone with their channel or message (or set on another device)
  // must leave the pending list — without disturbing the feed.
  it('activity.read reloads the pending reminders when they changed', () => {
    const client = makeClient();
    client.setQueryData(queryKeys.activity(), seeded());
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    applyActivityChangedEvent(client, { reminders: true });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.reminders() });

    applyActivityChangedEvent(client, { removed: ['a'], reminders: true });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<ActivityFeed>(queryKeys.activity())?.items).toEqual([]);

    applyActivityChangedEvent(client, { updated: ['b'], reminders: true });
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: queryKeys.activity() });
    expect(invalidate).toHaveBeenCalledTimes(4);
  });
});

describe('useActivityUnread', () => {
  it('is the unread count alone, 0 until the feed loads', async () => {
    let resolve: (v: unknown) => void = () => {};
    vi.mocked(apiFetch).mockImplementation(() => new Promise((r) => (resolve = r)) as never);
    const { result } = renderHook(() => useActivityUnread(), { wrapper: wrapperFor(makeClient()) });
    expect(result.current).toBe(0);
    resolve({ items: [], unread: 7, unreadByType: {} });
    await waitFor(() => expect(result.current).toBe(7));
  });
});
