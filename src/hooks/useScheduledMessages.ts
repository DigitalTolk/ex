import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { condemnDraftForSend, removeDraftScopeFromCache } from '@/hooks/useDrafts';
import { formatScheduleTime } from '@/lib/schedule-times';
import { showToast } from '@/lib/toast';
import type { ScheduledMessage } from '@/types';

export interface ScheduleMessageInput {
  parentID: string;
  parentType: 'channel' | 'conversation';
  parentMessageID?: string;
  body: string;
  attachmentIDs: string[];
  sendAt: Date;
}

const BASE = '/api/v1/scheduled-messages';

// useScheduledMessages is the user's scheduled messages, soonest first —
// pending ones and any that couldn't be delivered.
export function useScheduledMessages() {
  return useQuery({
    queryKey: queryKeys.scheduledMessages(),
    queryFn: async () => {
      const res = await apiFetch<ScheduledMessage[]>(BASE);
      return Array.isArray(res) ? res : [];
    },
  });
}

// scheduledFor narrows the list to one composer's scope: a chat's main
// composer (no thread) or a thread's reply box.
export function scheduledFor(
  list: ScheduledMessage[] | undefined,
  parentID: string | undefined,
  parentMessageID?: string,
): ScheduledMessage[] {
  return (list ?? []).filter((m) => m.parentID === parentID && (m.parentMessageID ?? '') === (parentMessageID ?? ''));
}

function refresh(qc: QueryClient) {
  return qc.invalidateQueries({ queryKey: queryKeys.scheduledMessages() });
}

// useScheduleMessage schedules a composed message. Like a send, it empties
// the composer's draft (the server clears it too).
export function useScheduleMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleMessageInput) =>
      apiFetch<ScheduledMessage>(BASE, {
        method: 'POST',
        body: JSON.stringify({
          parentID: input.parentID,
          parentType: input.parentType,
          parentMessageID: input.parentMessageID ?? '',
          body: input.body,
          attachmentIDs: input.attachmentIDs,
          sendAt: input.sendAt.toISOString(),
        }),
      }),
    onMutate: (input) => ({
      rollbackDraft: condemnDraftForSend({
        parentID: input.parentID,
        parentType: input.parentType,
        parentMessageID: input.parentMessageID || undefined,
      }),
    }),
    onError: (_err, _input, ctx) => ctx?.rollbackDraft(),
    onSuccess: (_m, input) => {
      removeDraftScopeFromCache(qc, {
        parentID: input.parentID,
        parentType: input.parentType,
        parentMessageID: input.parentMessageID || undefined,
      });
      void refresh(qc);
    },
  });
}

// useUpdateScheduledMessage edits the text and/or time.
export function useUpdateScheduledMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body, sendAt }: { id: string; body?: string; sendAt?: Date }) =>
      apiFetch<ScheduledMessage>(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ body, sendAt: sendAt?.toISOString() }),
      }),
    onSettled: () => refresh(qc),
  });
}

// useDeleteScheduledMessage drops one (its files are freed server-side).
export function useDeleteScheduledMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSettled: () => refresh(qc),
  });
}

// useSendScheduledNow posts one immediately — also how a failed one is retried.
export function useSendScheduledNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`${BASE}/${encodeURIComponent(id)}/send`, { method: 'POST' }),
    onSettled: () => refresh(qc),
  });
}

// useComposerSchedule wires a composer for "send later": its onSchedule (with
// a "Scheduled for …" confirmation that opens the Scheduled list) and how
// many messages are already scheduled from this chat or thread.
export function useComposerSchedule(scope: {
  parentID?: string;
  parentType: 'channel' | 'conversation';
  parentMessageID?: string;
}) {
  const schedule = useScheduleMessage();
  const { data } = useScheduledMessages();
  const navigate = useNavigate();
  const { parentID, parentType, parentMessageID } = scope;
  const onSchedule = useCallback(
    async (value: { body: string; attachmentIDs: string[] }, sendAt: Date) => {
      /* istanbul ignore next -- composers render only once their chat is loaded; defensive */
      if (!parentID) throw new Error('no chat to schedule into');
      try {
        await schedule.mutateAsync({ parentID, parentType, parentMessageID, sendAt, ...value });
      } catch (err) {
        showToast("Couldn't schedule the message — please try again.");
        throw err;
      }
      showToast(`Scheduled for ${formatScheduleTime(sendAt, new Date())}`, 'success', {
        onActivate: () => navigate('/drafts?tab=scheduled'),
      });
    },
    [schedule, parentID, parentType, parentMessageID, navigate],
  );
  return { onSchedule, scheduledCount: scheduledFor(data, parentID, parentMessageID).length };
}
