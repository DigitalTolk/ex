import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { showToast } from '@/lib/toast';
import {
  addActivityItem,
  applyActivityChange,
  markActivityItems,
  markAllActivityRead,
  parseActivityChange,
  parseActivityNew,
  removeActivityItems,
} from '@/lib/activity-feed';
import { withoutItems, withRead } from '@/lib/activity-groups';
import type { ActivityFeed, Reminder } from '@/types';

const EMPTY_FEED: ActivityFeed = { items: [], unread: 0, unreadByType: {} };

// useActivity loads the user's activity stream (mentions, thread replies, DMs,
// reactions, channel adds and fired reminders) plus the unread counts. The WS
// activity.new / activity.read events patch this cache (see
// applyActivityNewEvent) so the badge and list stay live without refetching.
export function useActivity() {
  return useQuery({
    queryKey: queryKeys.activity(),
    queryFn: async () => {
      const res = await apiFetch<ActivityFeed>('/api/v1/activity');
      // Coerce a malformed/empty response so the query never resolves undefined.
      if (!res || !Array.isArray(res.items)) return EMPTY_FEED;
      return {
        items: res.items,
        unread: typeof res.unread === 'number' ? res.unread : 0,
        unreadByType: res.unreadByType ?? {},
      };
    },
    staleTime: 10_000,
  });
}

// useReminders loads the user's pending (not-yet-fired) reminders.
export function useReminders() {
  return useQuery({
    queryKey: queryKeys.reminders(),
    queryFn: async () => {
      const res = await apiFetch<Reminder[]>('/api/v1/reminders');
      return Array.isArray(res) ? res : [];
    },
    staleTime: 10_000,
  });
}

export interface CreateReminderInput {
  messageID: string;
  parentID: string;
  parentType: 'channel' | 'conversation';
  channelSlug?: string;
  remindAt: string; // ISO8601
}

// useCreateReminder schedules a reminder, then refreshes the pending list. Both
// outcomes toast so scheduling is never silent — including the fire-and-forget
// preset quick-picks, which don't await the result.
export function useCreateReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateReminderInput) =>
      apiFetch<Reminder>('/api/v1/reminders', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.reminders() });
      showToast('Reminder set', 'success');
    },
    onError: () => {
      showToast("Couldn't set the reminder — please try again.");
    },
  });
}

// useCancelReminder cancels a pending reminder and refreshes the list.
export function useCancelReminder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.reminders() });
    },
  });
}

// patchActivity applies fn to the cached feed. With no cache, a fetch in flight
// (its response would overwrite the patch), or a change fn can't resolve
// (null), it refetches instead — invalidating also restarts an in-flight fetch.
function patchActivity(qc: QueryClient, fn: (feed: ActivityFeed) => ActivityFeed | null) {
  const key = queryKeys.activity();
  const feed = qc.getQueryData<ActivityFeed>(key);
  const next = feed && qc.isFetching({ queryKey: key }) === 0 ? fn(feed) : null;
  if (next) qc.setQueryData(key, next);
  else void qc.invalidateQueries({ queryKey: key });
}

// applyActivityNewEvent adds the item an activity.new event carries.
export function applyActivityNewEvent(qc: QueryClient, data: unknown) {
  const item = parseActivityNew(data);
  patchActivity(qc, (feed) => (item ? addActivityItem(feed, item) : null));
}

// applyActivityChangedEvent applies the change an activity.read event carries —
// read/unread marks and removals from any of the user's devices, or a read of
// part of a channel, conversation or thread (which refetches).
export function applyActivityChangedEvent(qc: QueryClient, data: unknown) {
  const change = parseActivityChange(data);
  patchActivity(qc, (feed) => applyActivityChange(feed, change));
}

// optimisticActivity cancels in-flight feed reads (a response computed before
// the write would undo the patch) and applies the patch to the cache.
async function optimisticActivity(qc: QueryClient, fn: (feed: ActivityFeed) => ActivityFeed) {
  await qc.cancelQueries({ queryKey: queryKeys.activity() });
  qc.setQueryData<ActivityFeed>(queryKeys.activity(), (old) => (old ? fn(old) : old));
}

function activityWriteFailed() {
  showToast("Couldn't update activity — please try again.");
}

// useSetActivityItemsRead marks items read or unread ("Mark as read" / "Mark as
// unread", and opening a row). Optimistic; the refetch on settle reconciles.
export function useSetActivityItemsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, read }: { ids: string[]; read: boolean }) =>
      apiFetch<void>('/api/v1/activity/items/read', { method: 'PUT', body: JSON.stringify({ ids, read }) }),
    onMutate: ({ ids, read }) => optimisticActivity(qc, (feed) => markActivityItems(feed, ids, read)),
    onError: activityWriteFailed,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });
}

// useRemoveActivityItems deletes items from the stream ("Remove from activity").
export function useRemoveActivityItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>('/api/v1/activity/items/remove', { method: 'POST', body: JSON.stringify({ ids }) }),
    onMutate: (ids) => optimisticActivity(qc, (feed) => removeActivityItems(feed, ids)),
    onError: activityWriteFailed,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });
}

// useMarkActivityRead marks every item read ("Mark all as read") by advancing
// the server watermark, and optimistically marks the cached items read.
// onSettled refetches to reconcile with the advanced watermark, re-counting
// anything that arrived mid-flight as still unread.
export function useMarkActivityRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/v1/activity/read', { method: 'PUT' }),
    onMutate: () => optimisticActivity(qc, markAllActivityRead),
    onError: activityWriteFailed,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });
}

// useSetActivityRead marks specific items read or unread ("Mark as read" /
// "Mark as unread", and opening a row). The cache updates first so the dot
// and tab counts change instantly; the refetch afterwards reconciles.
export function useSetActivityRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ids, read }: { ids: string[]; read: boolean }) =>
      apiFetch<void>('/api/v1/activity/items/read', { method: 'PUT', body: JSON.stringify({ ids, read }) }),
    onMutate: async ({ ids, read }) => {
      await qc.cancelQueries({ queryKey: queryKeys.activity() });
      qc.setQueryData<ActivityFeed>(queryKeys.activity(), (old) => (old ? withRead(old, ids, read) : old));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });
}

// useRemoveActivity removes items from the feed ("Remove from activity").
export function useRemoveActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>('/api/v1/activity/items/remove', { method: 'POST', body: JSON.stringify({ ids }) }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: queryKeys.activity() });
      qc.setQueryData<ActivityFeed>(queryKeys.activity(), (old) => (old ? withoutItems(old, ids) : old));
    },
    onError: () => {
      showToast("Couldn't remove that from Activity — please try again.");
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });
}
