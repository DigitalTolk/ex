import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import type { ActivityFeed, Reminder } from '@/types';

const EMPTY_FEED: ActivityFeed = { items: [], unread: 0 };

// useActivity loads the user's activity stream (reaction hints + fired
// reminders) plus the unread count. WS `activity.new` invalidates this query
// (see ChatPage) so the badge and list stay live.
export function useActivity(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.activity(),
    queryFn: async () => {
      const res = await apiFetch<ActivityFeed>('/api/v1/activity');
      // Coerce a malformed/empty response so the query never resolves undefined.
      if (!res || !Array.isArray(res.items)) return EMPTY_FEED;
      return { items: res.items, unread: typeof res.unread === 'number' ? res.unread : 0 };
    },
    enabled: options?.enabled ?? true,
    staleTime: 10_000,
  });
}

// useReminders loads the user's pending (not-yet-fired) reminders.
export function useReminders(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.reminders(),
    queryFn: async () => {
      const res = await apiFetch<Reminder[]>('/api/v1/reminders');
      return Array.isArray(res) ? res : [];
    },
    enabled: options?.enabled ?? true,
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

// useCreateReminder schedules a reminder, then refreshes the pending list.
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
export function useMarkActivityRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/v1/activity/read', { method: 'PUT' }),
    onSuccess: () => {
      qc.setQueryData<ActivityFeed>(queryKeys.activity(), (old) =>
        old ? { ...old, unread: 0 } : old,
      );
    },
  });
}
