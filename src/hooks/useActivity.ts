import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { showToast } from '@/lib/toast';
import { withoutItems, withRead } from '@/lib/activity-groups';
import type { ActivityFeed, Reminder } from '@/types';

const EMPTY_FEED: ActivityFeed = { items: [], unread: 0, unreadByType: {} };

// useActivity loads the user's activity stream (mentions, thread replies, DMs,
// reactions, channel adds and fired reminders) plus the unread counts. WS `activity.new` invalidates this query
// (see ChatPage) so the badge and list stay live.
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

// useMarkActivityRead clears the unread badge by advancing the server watermark,
// and optimistically zeroes the local unread count.
//
// onMutate cancels any in-flight activity GET before applying the optimistic
// zero: the page fires the read PUT and the activity GET together on mount, and
// a GET whose response lands after the PUT but was computed before the watermark
// advanced would otherwise clobber the zero back to a stale non-zero count (the
// badge reappears despite the click). onSettled refetches to reconcile with the
// now-advanced server watermark, correctly re-counting anything that arrived
// mid-flight as still unread.
export function useMarkActivityRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/v1/activity/read', { method: 'PUT' }),
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: queryKeys.activity() });
      qc.setQueryData<ActivityFeed>(queryKeys.activity(), (old) =>
        old
          ? { ...old, unread: 0, unreadByType: {}, items: old.items.map((i) => ({ ...i, read: true })) }
          : old,
      );
    },
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
