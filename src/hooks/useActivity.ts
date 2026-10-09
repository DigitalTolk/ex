import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError, apiFetch } from '@/lib/api';
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
import type { ActivityFeed, Reminder } from '@/types';

const EMPTY_FEED: ActivityFeed = { items: [], unread: 0, unreadByType: {} };

// useActivity loads the user's activity stream (mentions, thread replies, DMs,
// reactions, channel adds and fired reminders) plus the unread counts. The WS
// activity.new / activity.read events patch this cache (see
// applyActivityNewEvent) so the badge and list stay live without refetching.
const activityQuery = {
  queryKey: queryKeys.activity(),
  queryFn: async (): Promise<ActivityFeed> => {
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
};

export function useActivity() {
  return useQuery(activityQuery);
}

// useActivityUnread is just the unread count, for the badges: a component
// that shows only the count doesn't re-render when the list changes.
export function useActivityUnread(): number {
  return useQuery({ ...activityQuery, select: (feed) => feed.unread }).data ?? 0;
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

// useCancelReminder cancels a pending reminder and refreshes the list. A
// reminder that already fired or was cancelled elsewhere answers 404: the
// refresh drops it quietly. Any other failure says so.
export function useCancelReminder() {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: queryKeys.reminders() });
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/v1/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => {
      refresh();
      if (!(err instanceof ApiError && err.status === 404)) showToast("Couldn't cancel the reminder — please try again.");
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

// applyRemindersChangedEvent reloads the pending reminders on reminders.changed:
// one was set or cancelled (on any device), fired, or went with its message or
// with access to its channel.
export function applyRemindersChangedEvent(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: queryKeys.reminders() });
}

interface ActivityWriteContext {
  // A feed read was in flight and got cancelled for this write.
  cancelledRead: boolean;
}

// optimisticActivity applies a write's patch to the cache. An in-flight feed
// read is cancelled first — computed before the write, its response would undo
// the patch — and the context remembers it: something asked for that read (an
// activity.read the cache couldn't patch, or an event that arrived while
// fetching), so the write reads again once it lands.
async function optimisticActivity(qc: QueryClient, fn: (feed: ActivityFeed) => ActivityFeed): Promise<ActivityWriteContext> {
  const key = queryKeys.activity();
  const cancelledRead = qc.isFetching({ queryKey: key }) > 0;
  await qc.cancelQueries({ queryKey: key });
  qc.setQueryData<ActivityFeed>(key, (old) => (old ? fn(old) : old));
  return { cancelledRead };
}

// A successful write needs no refetch of its own: when a write changes
// anything, the server answers with an activity.read event carrying the
// change, which every tab (this one included) applies. It re-runs only a read
// it cancelled. A failed write undoes its optimistic patch by refetching, and
// says so.
function useActivityWriteHandlers() {
  const qc = useQueryClient();
  const refetch = () => void qc.invalidateQueries({ queryKey: queryKeys.activity() });
  return {
    onSuccess: (_data: unknown, _vars: unknown, ctx: ActivityWriteContext | undefined) => {
      if (ctx?.cancelledRead) refetch();
    },
    onError: () => {
      refetch();
      showToast("Couldn't update activity — please try again.");
    },
  };
}

// useSetActivityItemsRead marks items read or unread ("Mark as read" / "Mark as
// unread", and opening a row).
export function useSetActivityItemsRead() {
  const qc = useQueryClient();
  const handlers = useActivityWriteHandlers();
  return useMutation({
    mutationFn: ({ ids, read }: { ids: string[]; read: boolean }) =>
      apiFetch<void>('/api/v1/activity/items/read', { method: 'PUT', body: JSON.stringify({ ids, read }) }),
    onMutate: ({ ids, read }) => optimisticActivity(qc, (feed) => markActivityItems(feed, ids, read)),
    ...handlers,
  });
}

// useRemoveActivityItems deletes items from the stream ("Remove from activity").
export function useRemoveActivityItems() {
  const qc = useQueryClient();
  const handlers = useActivityWriteHandlers();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>('/api/v1/activity/items/remove', { method: 'POST', body: JSON.stringify({ ids }) }),
    onMutate: (ids) => optimisticActivity(qc, (feed) => removeActivityItems(feed, ids)),
    ...handlers,
  });
}

// useMarkActivityRead marks every item read ("Mark all as read") by advancing
// the server watermark, and optimistically marks the cached items read. Unlike
// the per-item writes it always re-reads once it lands: the {all} echo marks
// every cached item read, including one that arrived after the watermark was
// taken — only the server knows which items it actually covered.
export function useMarkActivityRead() {
  const qc = useQueryClient();
  const handlers = useActivityWriteHandlers();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/v1/activity/read', { method: 'PUT' }),
    onMutate: () => optimisticActivity(qc, markAllActivityRead),
    ...handlers,
    onSuccess: () => void qc.invalidateQueries({ queryKey: queryKeys.activity() }),
  });
}
